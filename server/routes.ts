import type { Express, Request } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  storage,
  seedDefaultAdmin,
  seedDefaultSettings,
  type Actor,
} from "./storage";
import {
  insertBootSchema,
  bootStatusSchema,
  manualPaidCarSchema,
  loginSchema,
  changePasswordSchema,
  createUserSchema,
  updateUserSchema,
  insertBootRequestSchema,
  resolveBootRequestSchema,
  updateSettingsSchema,
  type PaidSnapshot,
} from "@shared/schema";
import { fromZodError } from "zod-validation-error";
import { fetchPaidCars, normalizePlate, type PaidCar } from "./stripe";
import {
  attachUser,
  requireAuth,
  requireRole,
  verifyPassword,
  createToken,
  destroyToken,
  destroyUserSessions,
  setUserResolver,
} from "./auth";

// Extract the acting user as an audit Actor (id + display name).
function actorOf(req: Request): Actor | undefined {
  return req.user ? { id: req.user.id, name: req.user.name } : undefined;
}

// Read the bearer token off a request (for logout).
function tokenOf(req: Request): string | undefined {
  const auth = req.header("authorization") || req.header("Authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.header("x-auth-token") || undefined;
}

// Build [startUnix, endUnix) for a local-ish day. The client sends a
// YYYY-MM-DD plus its timezone offset (minutes) so day boundaries match
// the attendant's local day.
function dayRange(dateStr: string, tzOffsetMin: number): [number, number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Local midnight in UTC = UTC midnight + offset.
  const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) + tzOffsetMin * 60000;
  const start = Math.floor(startUtcMs / 1000);
  const end = start + 24 * 60 * 60;
  return [start, end];
}

// Local day (YYYY-MM-DD) for an ISO timestamp, given a tz offset (minutes,
// as returned by JS getTimezoneOffset(): positive = behind UTC).
function localDayKey(iso: string, tzOffsetMin: number): string {
  const localMs = new Date(iso).getTime() - tzOffsetMin * 60000;
  return new Date(localMs).toISOString().slice(0, 10);
}

// "Today" in the attendant's timezone.
function todayKey(tzOffsetMin: number): string {
  return localDayKey(new Date().toISOString(), tzOffsetMin);
}

// Subtract `daysBack` local days from `dayStr` (YYYY-MM-DD), returning a
// YYYY-MM-DD string. Used to compute the earliest day staff may view.
function dayMinus(dayStr: string, daysBack: number): string {
  const [y, m, d] = dayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) - daysBack * 86400000);
  return dt.toISOString().slice(0, 10);
}

// Staff (enforcer + attendant) are limited to a sliding window of recent days
// to keep older payment history private. Admin always bypasses this and sees
// the full 30-day retention window.
//   - Returns the earliest local day (YYYY-MM-DD) the given request's user may
//     view, or null if the user is admin (no restriction).
async function staffVisibleCutoffDay(
  req: Request,
  tz: number,
): Promise<string | null> {
  // No user (shouldn't happen behind requireAuth) -> treat as most restricted.
  if (!req.user || req.user.role === "admin") return null;
  const { historyVisibleDays } = await storage.getSettings();
  return dayMinus(todayKey(tz), historyVisibleDays);
}

// Map a stored snapshot row to the PaidCar shape the frontend expects.
function snapshotToCar(s: PaidSnapshot): PaidCar {
  return {
    id: s.sessionId,
    makeModel: s.makeModel,
    color: s.color,
    licensePlate: s.licensePlate,
    paidAt: s.paidAt,
    source: s.source === "manual" ? "manual" : "stripe",
  };
}

// Merge manually-entered paid cars for a day into a list of cars, de-duping
// by normalized plate (manual entry wins so the attendant's note is kept).
// Returns the combined list sorted by paidAt (newest first).
async function mergeManual(day: string, cars: PaidCar[]): Promise<PaidCar[]> {
  const manual = await storage.getManualSnapshotsForDay(day);
  if (manual.length === 0) return cars;
  const manualCars = manual.map(snapshotToCar);
  const manualPlates = new Set(
    manual.map((m) => m.normalizedPlate).filter(Boolean),
  );
  const deduped = cars.filter(
    (c) => !manualPlates.has(normalizePlate(c.licensePlate)),
  );
  const merged = [...manualCars, ...deduped];
  merged.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  return merged;
}

// Resolve paid cars for a given local day.
//   - Today (or future): always read LIVE from Stripe. Also refresh the
//     snapshot so the day is preserved once it rolls into the past.
//   - Past day with a stored snapshot: serve the snapshot (fast, stable).
//   - Past day WITHOUT a snapshot: backfill LIVE from Stripe, then save it.
// Returns { cars, source } where source is "live" or "stored".
async function resolvePaidCars(
  date: string,
  tz: number,
): Promise<{ cars: PaidCar[]; source: "live" | "stored" }> {
  const today = todayKey(tz);
  const isPast = date < today;

  if (isPast) {
    const hasSnap = await storage.hasSnapshotForDay(date);
    if (hasSnap) {
      const rows = await storage.getSnapshotsForDay(date);
      const cars = rows.map(snapshotToCar);
      cars.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
      // Stored rows already include any manual entries for the day.
      return { cars, source: "stored" };
    }
  }

  // Today, future, or a past day we haven't captured yet: fetch live.
  const [start, end] = dayRange(date, tz);
  const stripeCars = await fetchPaidCars(start, end);
  stripeCars.forEach((c) => (c.source = "stripe"));

  // Persist the Stripe rows for this day (skip empty future days). This
  // preserves any manual rows already stored for the day.
  if (stripeCars.length > 0 || isPast) {
    await storage.replaceSnapshotsForDay(
      date,
      stripeCars.map((c) => ({
        day: date,
        sessionId: c.id,
        licensePlate: c.licensePlate,
        normalizedPlate: normalizePlate(c.licensePlate),
        makeModel: c.makeModel,
        color: c.color,
        paidAt: c.paidAt,
        source: "stripe",
      })),
    );
  }

  // Merge in manual entries for the day (live today + uncaptured past).
  const cars = await mergeManual(date, stripeCars);
  return { cars, source: "live" };
}

// Run a best-effort 30-day prune for boots + snapshots.
async function pruneRetention(tz: number): Promise<void> {
  const today = todayKey(tz);
  const [y, m, d] = today.split("-").map(Number);
  // 30 days before today (local).
  const cutoff = new Date(Date.UTC(y, m - 1, d) - 30 * 24 * 60 * 60 * 1000);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  // Boots store an ISO instant; compare against the cutoff day's UTC midnight
  // shifted by tz so we don't prune same-day-boundary records prematurely.
  const cutoffIso = new Date(
    Date.UTC(y, m - 1, d) - 30 * 24 * 60 * 60 * 1000 + tz * 60000,
  ).toISOString();
  try {
    await storage.pruneOlderThan(cutoffDay, cutoffIso);
  } catch {
    // Non-fatal: retention is best-effort.
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // Ensure there's always an admin to log in as, and that settings exist.
  await seedDefaultSettings();
  await seedDefaultAdmin();
  // Let the auth layer resolve a user id -> public User via storage.
  setUserResolver((id) => storage.getUserById(id));
  // Attach req.user (when a valid token is present) to every API request.
  app.use("/api", attachUser);

  // ---- Auth ----
  // POST /api/auth/login { username, password } -> { token, user }
  app.post("/api/auth/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const { username, password, rememberMe } = parsed.data;
    const row = await storage.getUserByUsername(username);
    if (!row || !row.active || !verifyPassword(password, row.passwordHash)) {
      return res.status(401).json({ message: "Invalid username or password" });
    }
    const { passwordHash, ...user } = row;
    const token = await createToken(user.id, rememberMe);
    res.json({ token, user });
  });

  // GET /api/auth/me -> the current user (or 401)
  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // POST /api/auth/change-password { currentPassword, newPassword }
  // Self-service: the signed-in user changes their own password. Used both for
  // the forced first-login change (mustChangePassword) and voluntary changes.
  app.post("/api/auth/change-password", requireAuth, async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const { currentPassword, newPassword } = parsed.data;
    const me = req.user!;
    // Re-fetch with the hash to verify the current password.
    const row = await storage.getUserByUsername(me.username);
    if (!row || !verifyPassword(currentPassword, row.passwordHash)) {
      return res
        .status(400)
        .json({ message: "Current password is incorrect" });
    }
    if (currentPassword === newPassword) {
      return res
        .status(400)
        .json({ message: "New password must be different" });
    }
    const updated = await storage.setOwnPassword(me.id, newPassword);
    res.json({ user: updated });
  });

  // POST /api/auth/logout -> invalidate the current token
  app.post("/api/auth/logout", async (req, res) => {
    await destroyToken(tokenOf(req));
    res.status(204).end();
  });

  // ---- Users (admin only) ----
  app.get("/api/users", requireRole("admin"), async (_req, res) => {
    res.json(await storage.getUsers());
  });

  app.post("/api/users", requireRole("admin"), async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const existing = await storage.getUserByUsername(parsed.data.username);
    if (existing) {
      return res.status(409).json({ message: "That username is already taken" });
    }
    const user = await storage.createUser(parsed.data);
    res.status(201).json(user);
  });

  app.patch("/api/users/:id", requireRole("admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const target = await storage.getUserById(id);
    if (!target) return res.status(404).json({ message: "User not found" });

    // Guard against locking everyone out: don't allow demoting or deactivating
    // the last active admin.
    const demotingFromAdmin =
      target.role === "admin" &&
      ((parsed.data.role && parsed.data.role !== "admin") ||
        parsed.data.active === false);
    if (demotingFromAdmin) {
      const admins = await storage.countActiveAdmins();
      if (admins <= 1) {
        return res.status(400).json({
          message: "Can't remove the last active admin",
        });
      }
    }

    const updated = await storage.updateUser(id, parsed.data);
    // If role/password/active changed, invalidate the target's sessions so the
    // change takes effect immediately (they'll be forced to re-auth).
    if (
      parsed.data.role !== undefined ||
      parsed.data.password !== undefined ||
      parsed.data.active === false
    ) {
      await destroyUserSessions(id);
    }
    res.json(updated);
  });

  // ---- App settings ----
  // GET /api/settings -> current settings (any signed-in user; the frontend
  // needs historyVisibleDays to clamp staff date pickers and history lists).
  app.get("/api/settings", requireAuth, async (_req, res) => {
    res.json(await storage.getSettings());
  });

  // PATCH /api/settings { historyVisibleDays } -> updated settings (admin only).
  app.patch("/api/settings", requireRole("admin"), async (req, res) => {
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const updated = await storage.updateSettings(parsed.data);
    res.json(updated);
  });

  // ---- Boot requests ----
  // List: any signed-in user can see the queue.
  app.get("/api/boot-requests", requireAuth, async (_req, res) => {
    res.json(await storage.getBootRequests());
  });

  // Create: attendants (and admins) submit requests for an enforcer to act on.
  app.post(
    "/api/boot-requests",
    requireRole("attendant", "admin"),
    async (req, res) => {
      const parsed = insertBootRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ message: fromZodError(parsed.error).toString() });
      }
      const reqRow = await storage.createBootRequest(parsed.data, actorOf(req)!);
      res.status(201).json(reqRow);
    },
  );

  // Resolve: enforcers/admins initiate (-> real boot) or dismiss a request.
  app.patch(
    "/api/boot-requests/:id",
    requireRole("enforcer", "admin"),
    async (req, res) => {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid id" });
      const parsed = resolveBootRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ message: fromZodError(parsed.error).toString() });
      }
      const reqRow = await storage.getBootRequest(id);
      if (!reqRow) return res.status(404).json({ message: "Request not found" });
      if (reqRow.status !== "pending") {
        return res
          .status(409)
          .json({ message: "This request has already been resolved" });
      }

      if (parsed.data.action === "dismiss") {
        const updated = await storage.resolveBootRequest(
          id,
          "dismissed",
          actorOf(req)!,
          null,
        );
        return res.json({ request: updated, boot: null });
      }

      // initiate: create a real boot from the request, carrying its photos and
      // the enforcer-confirmed (or suggested) fee. The acting enforcer is the
      // boot's creator for audit purposes.
      const fee =
        parsed.data.bootFee != null ? parsed.data.bootFee : reqRow.suggestedFee;
      const boot = await storage.createBoot(
        {
          licensePlate: reqRow.licensePlate,
          makeModel: reqRow.makeModel,
          bootedAt: new Date().toISOString(),
          bootFee: fee,
          photos: reqRow.photos,
        },
        actorOf(req)!,
      );
      const updated = await storage.resolveBootRequest(
        id,
        "initiated",
        actorOf(req)!,
        boot.id,
      );
      res.status(201).json({ request: updated, boot });
    },
  );

  // ---- Booted cars (local SQLite) ----
  // Staff see only boots within their visible window (older payment history is
  // hidden); admins see everything.
  app.get("/api/boots", requireAuth, async (req, res) => {
    // tz offset (minutes) so day boundaries match the user's local day.
    const tz = Number(req.query.tz ?? 0) || 0;
    const boots = await storage.getBoots();
    const cutoff = await staffVisibleCutoffDay(req, tz);
    if (cutoff) {
      const visible = boots.filter(
        (b) => localDayKey(b.bootedAt, tz) >= cutoff,
      );
      return res.json(visible);
    }
    res.json(boots);
  });

  // Place a boot directly: enforcers + admins only. Attendants must request.
  app.post(
    "/api/boots",
    requireRole("enforcer", "admin"),
    async (req, res) => {
      const parsed = insertBootSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ message: fromZodError(parsed.error).toString() });
      }
      const boot = await storage.createBoot(parsed.data, actorOf(req));
      res.status(201).json(boot);
    },
  );

  // ---- Advance a boot through the enforcement lifecycle ----
  // PATCH /api/boots/:id  { status, amountCollected? }
  //   released  -> $0 collected (boot removed for no fee)
  //   settled   -> partial amount collected (must be > 0, < bootFee)
  //   completed -> full boot fee collected (defaults to bootFee)
  //   booted    -> re-open an active case (collected reset to 0)
  // Enforcement workflow: enforcers + admins only.
  app.patch("/api/boots/:id", requireRole("enforcer", "admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const parsed = bootStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }

    const existing = (await storage.getBoots()).find((b) => b.id === id);
    if (!existing) {
      return res.status(404).json({ message: "Boot not found" });
    }

    const { status } = parsed.data;
    const fee = existing.bootFee ?? 0;
    let amountCollected = 0;
    let resolvedAt: string | null = new Date().toISOString();

    switch (status) {
      case "booted":
        // Re-open: clear collected amount and resolution time.
        amountCollected = 0;
        resolvedAt = null;
        break;
      case "released":
        // Released for no fee.
        amountCollected = 0;
        break;
      case "completed":
        // Paid in full: default to the full boot fee unless overridden.
        amountCollected =
          parsed.data.amountCollected != null
            ? parsed.data.amountCollected
            : fee;
        break;
      case "settled": {
        // Settled for less: require a positive partial amount.
        const amt = parsed.data.amountCollected;
        if (amt == null || amt <= 0) {
          return res.status(400).json({
            message: "A collected amount is required to settle a boot.",
          });
        }
        amountCollected = amt;
        break;
      }
    }

    const updated = await storage.updateBootStatus(
      id,
      status,
      amountCollected,
      resolvedAt,
      actorOf(req),
    );
    res.json(updated);
  });

  // Deleting a boot entry is destructive: admins only.
  app.delete("/api/boots/:id", requireRole("admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const result = await storage.deleteBoot(id);
    if (result.changes === 0) {
      return res.status(404).json({ message: "Boot not found" });
    }
    res.status(204).end();
  });

  // ---- Paid cars (live today, stored snapshot for past days) ----
  // GET /api/paid-cars?date=YYYY-MM-DD&tz=<offsetMinutes>
  app.get("/api/paid-cars", requireAuth, async (req, res) => {
    const date = String(req.query.date || "");
    const tz = Number(req.query.tz ?? 0) || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
    // Staff cannot read paid-car history older than their visible window.
    const cutoff = await staffVisibleCutoffDay(req, tz);
    if (cutoff && date < cutoff) {
      return res
        .status(403)
        .json({ message: "This date is outside your visible history window." });
    }
    try {
      const { cars, source } = await resolvePaidCars(date, tz);
      res.json({ cars, source });
    } catch (err: any) {
      res.status(502).json({ message: err.message || "Stripe request failed" });
    }
  });

  // ---- Manually log a paid car for a given day ----
  // POST /api/paid-cars/manual  { date, tz, licensePlate, makeModel, color }
  // Logging a paid car: attendants, enforcers, and admins (any signed-in user).
  app.post("/api/paid-cars/manual", requireAuth, async (req, res) => {
    const parsed = manualPaidCarSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const { date, tz, licensePlate, makeModel, color } = parsed.data;

    // Staff cannot log paid cars onto days outside their visible window.
    const cutoff = await staffVisibleCutoffDay(req, tz);
    if (cutoff && date < cutoff) {
      return res
        .status(403)
        .json({ message: "This date is outside your visible history window." });
    }

    // If this is a PAST day with no snapshot yet, capture Stripe first so the
    // manual row is added on top of (not instead of) that day's live data.
    const today = todayKey(tz);
    if (date < today && !(await storage.hasSnapshotForDay(date))) {
      try {
        await resolvePaidCars(date, tz);
      } catch {
        // If Stripe is briefly unreachable we still allow the manual add.
      }
    }

    const now = new Date().toISOString();
    const row = await storage.addManualSnapshot({
      day: date,
      sessionId: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      licensePlate,
      normalizedPlate: normalizePlate(licensePlate),
      makeModel,
      color,
      paidAt: now,
      source: "manual",
    });
    res.status(201).json(snapshotToCar(row));
  });

  // ---- Cross-reference: normalized plates that paid that day ----
  // GET /api/cross-reference?date=YYYY-MM-DD&tz=<offsetMinutes>
  app.get("/api/cross-reference", requireAuth, async (req, res) => {
    const date = String(req.query.date || "");
    const tz = Number(req.query.tz ?? 0) || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
    // Staff cannot cross-reference days outside their visible window.
    const cutoff = await staffVisibleCutoffDay(req, tz);
    if (cutoff && date < cutoff) {
      return res
        .status(403)
        .json({ message: "This date is outside your visible history window." });
    }
    try {
      const { cars } = await resolvePaidCars(date, tz);
      const paidPlates = new Set(
        cars.map((p) => normalizePlate(p.licensePlate)).filter(Boolean),
      );
      res.json({ paidPlates: Array.from(paidPlates) });
    } catch (err: any) {
      res.status(502).json({ message: err.message || "Stripe request failed" });
    }
  });

  // ---- 30-day history: per-day boot / paid / enforcement counts ----
  // GET /api/history?tz=<offsetMinutes>
  // Returns the last 30 days (most recent first). Paid counts come from
  // stored snapshots for past days and live Stripe for today. Boots come
  // from the local DB. Enforcement = booted plates with no matching payment.
  app.get("/api/history", requireAuth, async (req, res) => {
    const tz = Number(req.query.tz ?? 0) || 0;
    try {
      await pruneRetention(tz);

      const today = todayKey(tz);
      const [ty, tm, td] = today.split("-").map(Number);

      // Admins see the full 30-day window; staff are limited to today plus
      // `historyVisibleDays` days back (= historyVisibleDays + 1 entries) so
      // older payment history stays private.
      let dayCount = 30;
      const cutoff = await staffVisibleCutoffDay(req, tz);
      if (cutoff) {
        const { historyVisibleDays } = await storage.getSettings();
        dayCount = Math.min(30, historyVisibleDays + 1);
      }

      // Build the list of visible local days (today back, most recent first).
      const days: string[] = [];
      for (let i = 0; i < dayCount; i++) {
        const dt = new Date(Date.UTC(ty, tm - 1, td) - i * 86400000);
        days.push(dt.toISOString().slice(0, 10));
      }

      // Boots grouped by local day + their normalized plates.
      const boots = await storage.getBoots();
      const bootsByDay = new Map<
        string,
        { count: number; fees: number; plates: Set<string> }
      >();
      for (const b of boots) {
        const key = localDayKey(b.bootedAt, tz);
        const entry =
          bootsByDay.get(key) ||
          { count: 0, fees: 0, plates: new Set<string>() };
        entry.count += 1;
        entry.fees += b.amountCollected ?? 0;
        entry.plates.add(normalizePlate(b.licensePlate));
        bootsByDay.set(key, entry);
      }

      // Backfill: for any PAST day in the window that has booted cars but no
      // stored snapshot yet, fetch it live once and persist. This keeps the
      // history's paid/enforcement counts accurate without the attendant
      // having to open each day first. Best-effort; ignore Stripe hiccups.
      for (const day of days) {
        if (day === today) continue; // today handled live below
        const hasBoots = (bootsByDay.get(day)?.count ?? 0) > 0;
        if (!hasBoots) continue;
        const hasSnap = await storage.hasSnapshotForDay(day);
        if (hasSnap) continue;
        try {
          await resolvePaidCars(day, tz); // backfills + saves snapshot
        } catch {
          // ignore
        }
      }

      // Paid plates per day: snapshots for past days; live for today.
      const snaps = await storage.getAllSnapshots();
      const paidByDay = new Map<string, Set<string>>();
      const paidCountByDay = new Map<string, number>();
      for (const s of snaps) {
        if (!paidByDay.has(s.day)) paidByDay.set(s.day, new Set());
        paidByDay.get(s.day)!.add(s.normalizedPlate);
        paidCountByDay.set(s.day, (paidCountByDay.get(s.day) || 0) + 1);
      }

      // Ensure today is fresh/live (also refreshes its snapshot).
      try {
        const { cars } = await resolvePaidCars(today, tz);
        const set = new Set(
          cars.map((c) => normalizePlate(c.licensePlate)).filter(Boolean),
        );
        paidByDay.set(today, set);
        paidCountByDay.set(today, cars.length);
      } catch {
        // If Stripe is briefly unreachable, fall back to any stored snapshot.
      }

      const items = days.map((day) => {
        const b = bootsByDay.get(day);
        const bootCount = b?.count ?? 0;
        const fees = b?.fees ?? 0;
        const paidSet = paidByDay.get(day) ?? new Set<string>();
        const paidCount = paidCountByDay.get(day) ?? 0;
        // Enforcement candidates: booted plates not present in paid set.
        let enforcement = 0;
        if (b) {
          for (const plate of b.plates) {
            if (plate && !paidSet.has(plate)) enforcement += 1;
          }
        }
        return {
          day,
          isToday: day === today,
          bootCount,
          fees,
          paidCount,
          enforcement,
        };
      });

      res.json({ days: items });
    } catch (err: any) {
      res
        .status(500)
        .json({ message: err.message || "Failed to build history" });
    }
  });

  return httpServer;
}
