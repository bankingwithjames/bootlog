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
  insertReleaseRequestSchema,
  updateSettingsSchema,
  insertLocationSchema,
  updateLocationSchema,
  checkInShiftSchema,
  checkOutShiftSchema,
  type PaidSnapshot,
  enforcementActionSchema,
  ENFORCEMENT_STAGES,
  type EnforcementStage,
} from "@shared/schema";
import { fromZodError } from "zod-validation-error";
import { fetchPaidCars, normalizePlate, type PaidCar } from "./stripe";
import {
  geocodeAddress,
  isInsideGeofence,
  buildStaticMapUrl,
  fetchStaticMap,
} from "./geo";
import {
  notifyShiftCheckIn,
  notifyShiftCheckOut,
  notifyReleaseRequest,
  notifyBootRequest,
} from "./sms";
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

// Whether the requesting user may see/record financial amounts.
//   - admin -> always true (admin bypasses the staff gate)
//   - staff (attendant/enforcer) -> only when showFinancialsToStaff is on
async function staffCanSeeFinancials(req: Request): Promise<boolean> {
  if (req.user?.role === "admin") return true;
  const { showFinancialsToStaff } = await storage.getSettings();
  return showFinancialsToStaff;
}

// Human-readable elapsed label between two ISO timestamps, e.g. "3h 12m".
// Used in the check-out SMS so the recipient sees how long the shift ran.
function shiftDurationLabel(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "0m";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Resolve which location ids a request's user is allowed to see/act on.
//   - admin -> null (no restriction; sees all locations)
//   - staff -> the set of location ids assigned to them in staff_locations
// Staff are additionally always allowed to see untagged boots (location_id
// null) so pre-existing records and "No location" picks stay visible.
async function allowedLocationIds(req: Request): Promise<number[] | null> {
  if (!req.user || req.user.role === "admin") return null;
  return storage.getLocationIdsForUser(req.user.id);
}

// Map a stored snapshot row to the PaidCar shape the frontend expects.
function snapshotToCar(s: PaidSnapshot): PaidCar {
  const method = (s.method as "cash" | "card" | "app" | null) ?? null;
  return {
    id: s.sessionId,
    makeModel: s.makeModel,
    color: s.color,
    licensePlate: s.licensePlate,
    paidAt: s.paidAt,
    source: s.source === "manual" ? "manual" : "stripe",
    amount: s.amount ?? null,
    method,
    space: s.space ?? null,
    // For persisted app charges the parking-lot address was stored in `space`;
    // surface it back as lotAddress so the UI meta line still shows the lot.
    lotAddress: method === "app" ? s.space ?? null : null,
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

// How long the live Stripe pass may take before we fall back to the day's
// stored snapshot. Kept comfortably under the published-sandbox proxy's request
// budget so the response returns (with cached data) instead of the proxy
// emitting an empty-body 503.
const STRIPE_LIVE_BUDGET_MS = 2500;

// Short-TTL in-memory cache for the admin overview response. The overview runs
// 6 parallel Supabase reads plus a live Stripe pass; on the published-sandbox
// proxy (~4-5s request budget) that occasionally exceeds the budget and the
// proxy returns an empty-body 503. The admin dashboard polls this endpoint, so
// caching the assembled payload for a few seconds lets repeated requests return
// instantly (well under the budget) while keeping data effectively live.
const OVERVIEW_CACHE_TTL_MS = 8000;
// How long a cached payload may still be served as a fast fallback while a fresh
// one is rebuilt in the background. Bridges the cold request after the TTL
// lapses so it never blocks long enough for the proxy to emit a 503.
const OVERVIEW_STALE_MAX_MS = 60000;
const overviewCache = new Map<string, { at: number; payload: unknown }>();
// Tracks an in-flight rebuild per cache key so concurrent requests don't all
// run the heavy assembly at once.
const overviewRefreshing = new Set<string>();

// Race a promise against a timeout. Used to bound slow live-Stripe lookups so a
// heavy endpoint degrades gracefully (fall back to snapshot / stripeOk=false)
// within the published-sandbox proxy's request budget instead of hanging until
// the proxy emits a 503 with an empty body.
function withTimeout<T>(p: Promise<T>, ms: number, label = "op"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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

  // Bound the live Stripe pass. The published pplx.app sandbox routes backend
  // requests through a proxy with a short request budget; as the day fills up
  // with charges, the live fetch (pagination + per-customer name lookups) can
  // exceed it and the proxy returns an empty-body 503. If the live fetch is too
  // slow OR errors, fall back to the most recent stored snapshot for the day so
  // the user still sees data instead of an error.
  let stripeCars: PaidCar[];
  try {
    stripeCars = await withTimeout(
      fetchPaidCars(start, end),
      STRIPE_LIVE_BUDGET_MS,
      "resolvePaidCars stripe",
    );
  } catch (err) {
    // Live fetch failed/timed out. Serve whatever we last snapshotted for the
    // day (plus manual rows), flagged as "stored" so callers know it may be a
    // moment stale. If there's no snapshot yet, re-throw so the caller can
    // surface the error (e.g. stripeOk=false on the dashboard).
    const hasSnap = await storage.hasSnapshotForDay(date);
    if (hasSnap) {
      const rows = await storage.getSnapshotsForDay(date);
      const cars = rows.map(snapshotToCar);
      cars.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
      return { cars, source: "stored" };
    }
    throw err;
  }
  stripeCars.forEach((c) => (c.source = "stripe"));

  // Persist the Stripe rows for this day (skip empty future days). This
  // preserves any manual rows already stored for the day. For the live (today)
  // path we DON'T await the write — it's a best-effort cache refresh and must
  // not delay the response (another slow Supabase round-trip would risk the
  // same proxy timeout). For past-day backfills we await so the snapshot is
  // guaranteed before we return.
  if (stripeCars.length > 0 || isPast) {
    const writePromise = storage.replaceSnapshotsForDay(
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
        // App/charge rows carry payment details that Checkout-Session rows
        // don't. Persist them so past-day snapshots keep the amount, the "app"
        // method, and the parking-lot address (stored in `space`, which is the
        // "where" column and otherwise null for Stripe rows).
        amount: c.amount ?? null,
        method: c.method ?? null,
        space: c.lotAddress ?? c.space ?? null,
      })),
    );
    if (isPast) {
      await writePromise;
    } else {
      // Fire-and-forget for the live path; swallow errors (best-effort cache).
      void writePromise.catch(() => {});
    }
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

  // ---- Parking locations (multi-location support) ----
  // GET /api/locations -> all locations with assigned-staff ids. Any signed-in
  // user can read (staff need it for the boot-form picker and labels); the
  // frontend gates the management UI to admins.
  app.get("/api/locations", requireAuth, async (_req, res) => {
    res.json(await storage.getLocations());
  });

  // GET /api/locations/mine -> the location ids assigned to the current user
  // (admins get all active location ids). Drives the boot-form default and
  // staff scoping on the client.
  app.get("/api/locations/mine", requireAuth, async (req, res) => {
    const me = req.user!;
    if (me.role === "admin") {
      const all = await storage.getLocations();
      return res.json({
        locationIds: all.filter((l) => l.active).map((l) => l.id),
      });
    }
    res.json({ locationIds: await storage.getLocationIdsForUser(me.id) });
  });

  // POST /api/locations { name, address?, color?, staffIds? } -> create (admin)
  app.post("/api/locations", requireRole("admin"), async (req, res) => {
    const parsed = insertLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const loc = await storage.createLocation(parsed.data);
    res.status(201).json(loc);
  });

  // PATCH /api/locations/:id { name?, address?, color?, active?, staffIds? }
  // Update a location and/or its staff assignment (admin only).
  app.patch("/api/locations/:id", requireRole("admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
    const parsed = updateLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const updated = await storage.updateLocation(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Location not found" });
    res.json(updated);
  });

  // ---- Shifts (attendant geofenced check-in / check-out) ----
  //
  // Resolve a location's geofence center, geocoding its address lazily on the
  // first need and caching the result. Returns null when the location has no
  // usable address / can't be geocoded yet.
  async function geofenceCenterFor(loc: {
    id: number;
    address: string;
    latitude: number | null;
    longitude: number | null;
  }): Promise<{ lat: number; lng: number } | null> {
    if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
      return { lat: loc.latitude, lng: loc.longitude };
    }
    const geo = await geocodeAddress(loc.address);
    if (!geo) return null;
    await storage.setLocationGeofenceCenter(loc.id, geo.lat, geo.lng);
    return geo;
  }

  // GET /api/shifts/active -> the current user's open shift (or null).
  app.get("/api/shifts/active", requireAuth, async (req, res) => {
    const shift = await storage.getActiveShiftForUser(req.user!.id);
    res.json({ shift: shift ?? null });
  });

  // GET /api/shifts/geofence/:locationId -> the geofence the client should draw
  // for a lot (center + radius), geocoding lazily. 422 if not geocodable yet.
  app.get("/api/shifts/geofence/:locationId", requireAuth, async (req, res) => {
    const locId = Number(req.params.locationId);
    if (Number.isNaN(locId))
      return res.status(400).json({ message: "Invalid location id" });
    // Attendants may only query a lot they're assigned to; admins, any.
    const allowed = await allowedLocationIds(req);
    if (allowed !== null && !allowed.includes(locId)) {
      return res.status(403).json({ message: "Not assigned to this location" });
    }
    const locations = await storage.getLocations();
    const loc = locations.find((l) => l.id === locId);
    if (!loc) return res.status(404).json({ message: "Location not found" });
    const center = await geofenceCenterFor(loc);
    if (!center) {
      return res.status(422).json({
        message:
          "This lot's address can't be located yet. Add a valid street address in lot settings.",
      });
    }
    res.json({
      locationId: loc.id,
      locationName: loc.name,
      address: loc.address,
      center,
      radiusMeters: loc.geofenceRadius,
    });
  });

  // GET /api/shifts/staticmap/:locationId?lat=&lng=&w=&h=
  // Server-proxied Google Static Maps image for the lot's geofence. The API key
  // is injected by the credential proxy on the outbound call, so it never ships
  // to the browser. Optional lat/lng plots the attendant's current position
  // (blue inside the fence, red outside). Returns the image bytes directly.
  app.get(
    "/api/shifts/staticmap/:locationId",
    requireAuth,
    async (req, res) => {
      const locId = Number(req.params.locationId);
      if (Number.isNaN(locId))
        return res.status(400).json({ message: "Invalid location id" });
      const allowed = await allowedLocationIds(req);
      if (allowed !== null && !allowed.includes(locId)) {
        return res
          .status(403)
          .json({ message: "Not assigned to this location" });
      }
      const locations = await storage.getLocations();
      const loc = locations.find((l) => l.id === locId);
      if (!loc) return res.status(404).json({ message: "Location not found" });
      const center = await geofenceCenterFor(loc);
      if (!center)
        return res
          .status(422)
          .json({ message: "This lot's address can't be located yet." });

      // Optional user position.
      const latRaw = Number(req.query.lat);
      const lngRaw = Number(req.query.lng);
      const user =
        !Number.isNaN(latRaw) &&
        !Number.isNaN(lngRaw) &&
        Math.abs(latRaw) <= 90 &&
        Math.abs(lngRaw) <= 180
          ? { lat: latRaw, lng: lngRaw }
          : null;

      // Clamp requested dimensions (Static Maps max 640x640 before scale).
      const w = Math.min(640, Math.max(200, Number(req.query.w) || 600));
      const h = Math.min(640, Math.max(120, Number(req.query.h) || 376));

      const mapPath = buildStaticMapUrl({
        center,
        radiusMeters: loc.geofenceRadius,
        user,
        widthPx: w,
        heightPx: h,
        scale: 2,
      });
      const img = await fetchStaticMap(mapPath);
      if (!img) {
        return res
          .status(502)
          .json({ message: "Map image is temporarily unavailable." });
      }
      res.setHeader("Content-Type", img.contentType);
      res.setHeader("Cache-Control", "private, max-age=30");
      return res.end(img.body);
    },
  );

  // POST /api/shifts/checkin { locationId, latitude, longitude, accuracy? }
  // Attendants (and admins) open a shift. HARD-BLOCKED: the captured GPS point
  // must be inside the location's geofence. Fires the check-in SMS (stubbed).
  app.post(
    "/api/shifts/checkin",
    requireRole("attendant", "admin"),
    async (req, res) => {
      const parsed = checkInShiftSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ message: fromZodError(parsed.error).toString() });
      }
      const me = req.user!;
      const { locationId, latitude, longitude } = parsed.data;

      // One open shift at a time.
      const existing = await storage.getActiveShiftForUser(me.id);
      if (existing) {
        return res
          .status(409)
          .json({ message: "You already have an open shift.", shift: existing });
      }

      // Must be assigned to the lot (admins bypass).
      const allowed = await allowedLocationIds(req);
      if (allowed !== null && !allowed.includes(locationId)) {
        return res
          .status(403)
          .json({ message: "You are not assigned to this lot." });
      }

      const locations = await storage.getLocations();
      const loc = locations.find((l) => l.id === locationId);
      if (!loc) return res.status(404).json({ message: "Location not found" });

      const center = await geofenceCenterFor(loc);
      if (!center) {
        return res.status(422).json({
          message:
            "This lot's address can't be located yet, so check-in can't be verified.",
        });
      }

      const inside = isInsideGeofence(
        { lat: latitude, lng: longitude },
        center,
        loc.geofenceRadius,
      );
      if (!inside) {
        // HARD BLOCK — no override.
        return res.status(403).json({
          message:
            "You must be inside the lot to check in. Move closer to the lot and try again.",
          code: "OUTSIDE_GEOFENCE",
        });
      }

      const shift = await storage.createShift({
        userId: me.id,
        userName: me.name,
        locationId: loc.id,
        locationName: loc.name,
        checkInLat: latitude,
        checkInLng: longitude,
        geofenceVerified: true,
      });
      notifyShiftCheckIn({
        byName: me.name,
        locationName: loc.name,
        at: shift.checkInAt,
      });
      res.status(201).json(shift);
    },
  );

  // PATCH /api/shifts/:id/checkout { latitude?, longitude? } -> close a shift.
  // Only the shift's owner (or an admin) may close it. Fires check-out SMS.
  app.patch(
    "/api/shifts/:id/checkout",
    requireRole("attendant", "admin"),
    async (req, res) => {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid shift id" });
      const parsed = checkOutShiftSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ message: fromZodError(parsed.error).toString() });
      }
      const me = req.user!;
      const shift = await storage.getShiftById(id);
      if (!shift) return res.status(404).json({ message: "Shift not found" });
      if (shift.checkOutAt)
        return res.status(409).json({ message: "Shift is already closed." });
      if (me.role !== "admin" && shift.userId !== me.id) {
        return res
          .status(403)
          .json({ message: "You can only check out of your own shift." });
      }
      const closed = await storage.closeShift(
        id,
        parsed.data.latitude ?? null,
        parsed.data.longitude ?? null,
      );
      if (!closed)
        return res.status(409).json({ message: "Shift is already closed." });
      const durationLabel = shiftDurationLabel(
        closed.checkInAt,
        closed.checkOutAt!,
      );
      notifyShiftCheckOut({
        byName: closed.userName,
        locationName: closed.locationName,
        at: closed.checkOutAt!,
        durationLabel,
      });
      res.json(closed);
    },
  );

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
      // Stubbed SMS to the on-duty enforcer (real provider wired later). The
      // boot-request table doesn't carry a locationId, so we resolve the lot
      // name from the requesting attendant's assigned location(s).
      const allowed = await allowedLocationIds(req);
      const locName =
        allowed && allowed.length
          ? (await storage.getLocations()).find((l) => l.id === allowed[0])
              ?.name
          : undefined;
      notifyBootRequest({
        plate: reqRow.licensePlate,
        makeModel: reqRow.makeModel,
        byName: actorOf(req)!.name,
        locationName: locName,
      });
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
          color: reqRow.color ?? null,
          bootedAt: new Date().toISOString(),
          bootFee: fee,
          photos: reqRow.photos,
          locationId: null,
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
    let boots = await storage.getBoots();
    // Location scoping: staff only see boots at their assigned locations, plus
    // untagged boots (location_id null) so pre-existing records stay visible.
    // Admins (allowed === null) see everything.
    const allowed = await allowedLocationIds(req);
    if (allowed) {
      const allowedSet = new Set(allowed);
      boots = boots.filter(
        (b) => b.locationId == null || allowedSet.has(b.locationId),
      );
    }
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
      // Location scoping: staff may only place boots at a location assigned to
      // them (or leave it untagged). Admins may place at any location.
      const locationId = parsed.data.locationId ?? null;
      if (locationId != null) {
        const allowed = await allowedLocationIds(req);
        if (allowed && !allowed.includes(locationId)) {
          return res.status(403).json({
            message: "You aren't assigned to that parking location.",
          });
        }
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

  // Attendant "Mark as Paid" (Page 4): attendants may close a booted vehicle as
  // paid in full. Distinct from the enforcer-only status PATCH above so the
  // admin/enforcer experience is unchanged. Sets status=completed and records
  // the full boot fee as collected. Lot-scoped for non-admins.
  app.patch(
    "/api/boots/:id/mark-paid",
    requireRole("attendant", "enforcer", "admin"),
    async (req, res) => {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) {
        return res.status(400).json({ message: "Invalid id" });
      }
      const existing = (await storage.getBoots()).find((b) => b.id === id);
      if (!existing) {
        return res.status(404).json({ message: "Boot not found" });
      }
      // Lot scoping: non-admins can only act on boots at their assigned lots
      // (or untagged boots). Admins may act on any.
      const allowed = await allowedLocationIds(req);
      if (
        allowed &&
        existing.locationId != null &&
        !allowed.includes(existing.locationId)
      ) {
        return res
          .status(403)
          .json({ message: "This vehicle is not at one of your lots." });
      }
      if (existing.status === "completed") {
        return res
          .status(409)
          .json({ message: "This vehicle is already marked paid." });
      }
      const fee = existing.bootFee ?? 0;
      const updated = await storage.updateBootStatus(
        id,
        "completed",
        fee,
        new Date().toISOString(),
        actorOf(req),
      );
      res.json(updated);
    },
  );

  // ---- Release requests (Page 4) ----
  // Attendants cannot remove boots; they submit a release request that queues
  // for an enforcer/admin and pings them via the (stubbed) SMS layer.
  app.get("/api/release-requests", requireAuth, async (_req, res) => {
    res.json(await storage.getReleaseRequests());
  });

  app.post(
    "/api/release-requests",
    requireRole("attendant", "enforcer", "admin"),
    async (req, res) => {
      const parsed = insertReleaseRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ message: fromZodError(parsed.error).toString() });
      }
      const boot = (await storage.getBoots()).find(
        (b) => b.id === parsed.data.bootId,
      );
      if (!boot) {
        return res.status(404).json({ message: "Boot not found" });
      }
      // Only an active (booted) vehicle can be requested for release.
      if (boot.status !== "booted") {
        return res.status(409).json({
          message: "This vehicle is not currently on a boot.",
        });
      }
      // Lot scoping for non-admins.
      const allowed = await allowedLocationIds(req);
      if (
        allowed &&
        boot.locationId != null &&
        !allowed.includes(boot.locationId)
      ) {
        return res
          .status(403)
          .json({ message: "This vehicle is not at one of your lots." });
      }
      const reqRow = await storage.createReleaseRequest(
        { bootId: boot.id, note: parsed.data.note ?? "" },
        {
          licensePlate: boot.licensePlate,
          makeModel: boot.makeModel,
          locationId: boot.locationId ?? null,
        },
        actorOf(req)!,
      );
      // Stubbed SMS to the enforcer (real provider wired later).
      const locName = boot.locationId
        ? (await storage.getLocations()).find((l) => l.id === boot.locationId)
            ?.name
        : undefined;
      notifyReleaseRequest({
        plate: boot.licensePlate,
        makeModel: boot.makeModel,
        byName: actorOf(req)!.name,
        bootId: boot.id,
        locationName: locName,
      });
      res.status(201).json(reqRow);
    },
  );

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
  // POST /api/paid-cars/manual
  //   { date, tz, licensePlate, makeModel, color, space?, amount?, method? }
  // Logging a paid vehicle at the lot is part of the attendant's day-to-day
  // job (Field Mode "Add Paid Vehicle"), so attendants, enforcers, and admins
  // may all record one. Stripe remains the system of record for online
  // payments; manual rows capture cash/card/app collected in the field.
  app.post("/api/paid-cars/manual", requireRole("attendant", "enforcer", "admin"), async (req, res) => {
    const parsed = manualPaidCarSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: fromZodError(parsed.error).toString() });
    }
    const { date, tz, licensePlate, makeModel, color, space, amount, method } =
      parsed.data;

    // Financials gating: when the admin hides financials from staff, ignore any
    // payment amount staff might send (the field is locked in their UI anyway).
    // The method/space are operational and remain allowed.
    //
    // EXCEPTION — cash collections: a CASH amount is always accepted regardless
    // of the financials setting, because the attendant cash tracker needs the
    // per-vehicle cash figure to compute the running total they owe the admin.
    // "Show financials to staff" only governs aggregate revenue KPIs (e.g.
    // "Collected today"), not the attendant's own cash-owed ledger.
    const showFinancials = await staffCanSeeFinancials(req);
    const effectiveAmount =
      showFinancials || method === "cash" ? amount ?? null : null;

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
      amount: effectiveAmount,
      method: method ?? null,
      space: space ?? null,
    });

    // When the field payment was taken in CASH and an amount was recorded, also
    // write an auditable cash-ledger row attributed to the collecting attendant.
    // This is the running total the attendant owes the admin until reconciled.
    if (method === "cash" && effectiveAmount && effectiveAmount > 0) {
      const actor = actorOf(req)!;
      try {
        await storage.addCashCollection({
          day: date,
          snapshotSessionId: row.sessionId,
          licensePlate,
          makeModel,
          amount: effectiveAmount,
          collectedById: actor.id,
          collectedByName: actor.name,
          collectedAt: now,
          reconciled: false,
          reconciledAt: null,
          reconciledByName: null,
        });
      } catch {
        // Cash-ledger write is best-effort: never block the operational paid row.
      }
    }
    res.status(201).json(snapshotToCar(row));
  });

  // ---- Delete a MANUAL paid-car entry ----
  // DELETE /api/paid-cars/manual/:sessionId
  // Removing a paid-car record is destructive and admins-only. The storage
  // layer additionally enforces source = 'manual', so a Stripe session id can
  // never be deleted through this route even if one were supplied.
  app.delete(
    "/api/paid-cars/manual/:sessionId",
    requireRole("admin"),
    async (req, res) => {
      const sessionId = String(req.params.sessionId || "");
      if (!sessionId) {
        return res.status(400).json({ message: "Invalid id" });
      }
      const result = await storage.deleteManualSnapshot(sessionId);
      if (result.changes === 0) {
        return res
          .status(404)
          .json({ message: "Manual paid entry not found" });
      }
      res.status(204).end();
    },
  );

  // ---- Cash collections: the current attendant's running cash total ----
  // GET /api/cash/mine -> { owedTotal, reconciledTotal, owedCount, recent[] }
  // The total of cash the signed-in attendant has logged (and still owes the
  // admin) from manual cash entries. Each staff member sees only their own.
  app.get("/api/cash/mine", requireAuth, async (req, res) => {
    const summary = await storage.getCashSummaryForCollector(req.user!.id);
    res.json(summary);
  });

  // POST /api/cash/verify  (admin only)
  // The admin reviews an attendant's unverified cash, then verifies + collects
  // the selected entries. Flipping reconciled=true removes them from the
  // attendant's owed tracker (resetting their running count) and stamps who
  // approved. Body: { ids: number[] }. Returns the reconciled rows + a fresh
  // summary for the affected collector so the UI can update immediately.
  app.post("/api/cash/verify", requireRole("admin"), async (req, res) => {
    const raw = (req.body?.ids ?? []) as unknown[];
    const ids = Array.from(
      new Set(
        raw
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    );
    if (ids.length === 0) {
      return res.status(400).json({ message: "No cash entries selected." });
    }
    const adminName = req.user!.name || req.user!.username || "Admin";
    const reconciled = await storage.reconcileCashCollections(ids, adminName);
    // The dashboard overview is cached; clear it so the verified amounts drop
    // out of "Cash owed to bank" on the admin's very next refresh.
    overviewCache.clear();
    const collectorId = reconciled[0]?.collectedById;
    const summary =
      collectorId != null
        ? await storage.getCashSummaryForCollector(collectorId)
        : null;
    res.json({
      verifiedCount: reconciled.length,
      verifiedTotal:
        Math.round(
          reconciled.reduce((s, c) => s + (Number(c.amount) || 0), 0) * 100,
        ) / 100,
      reconciledByName: adminName,
      collectorId: collectorId ?? null,
      summary,
    });
  });

  // POST /api/cash/void  (admin only)
  // Soft-deletes (voids) a single cash entry. The row stays in the ledger as an
  // audit trail (with who voided it + when), but is excluded from every total,
  // holder tracker, recent list, and the attendant's own view — so balances
  // self-correct. Body: { id: number }. Returns the voided row + a fresh
  // summary for the affected collector so the UI can update immediately.
  app.post("/api/cash/void", requireRole("admin"), async (req, res) => {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "A valid cash entry id is required." });
    }
    const adminName = req.user!.name || req.user!.username || "Admin";
    const voided = await storage.voidCashCollection(id, adminName);
    if (!voided) {
      // Already voided or not found — idempotent no-op from the client's view.
      return res.status(404).json({ message: "Cash entry not found or already voided." });
    }
    // The dashboard overview is cached; clear it so the voided amount drops out
    // of every total + list on the admin's very next refresh.
    overviewCache.clear();
    const collectorId = voided.collectedById;
    const summary =
      collectorId != null
        ? await storage.getCashSummaryForCollector(collectorId)
        : null;
    res.json({
      voidedId: voided.id,
      voidedAmount: Math.round((Number(voided.amount) || 0) * 100) / 100,
      voidedByName: adminName,
      collectorId: collectorId ?? null,
      summary,
    });
  });

  // ---- Shifts: the current user's own shift history (timesheet) ----
  // GET /api/shifts/mine -> { shifts: Shift[] } newest first.
  app.get("/api/shifts/mine", requireAuth, async (req, res) => {
    const shifts = await storage.getShiftsForUser(req.user!.id);
    res.json({ shifts });
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
    // Optional per-location filter. `locationId=none` narrows to untagged
    // boots; a numeric id narrows to that location; omitted = all locations.
    const rawLoc = req.query.locationId;
    const locFilter:
      | { kind: "all" }
      | { kind: "none" }
      | { kind: "id"; id: number } =
      rawLoc == null || rawLoc === ""
        ? { kind: "all" }
        : rawLoc === "none"
          ? { kind: "none" }
          : { kind: "id", id: Number(rawLoc) };
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

      // Boots grouped by local day + their normalized plates. Staff history is
      // scoped to their assigned locations (plus untagged); admins see all.
      let boots = await storage.getBoots();
      const allowedHist = await allowedLocationIds(req);
      if (allowedHist) {
        const allowedSet = new Set(allowedHist);
        boots = boots.filter(
          (b) => b.locationId == null || allowedSet.has(b.locationId),
        );
      }
      // Apply the optional per-location filter on top of access scoping.
      if (locFilter.kind === "none") {
        boots = boots.filter((b) => b.locationId == null);
      } else if (locFilter.kind === "id" && Number.isFinite(locFilter.id)) {
        boots = boots.filter((b) => b.locationId === locFilter.id);
      }
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

  // =========================================================================
  // Enforcer Mobile Preview API (preview-only, flag-gated, additive)
  // =========================================================================
  // These endpoints power the /preview/enforcer-mobile experience. They are
  // registered ONLY when ENABLE_ENFORCER_MOBILE_PREVIEW is set, so production
  // deployments without the flag never expose them. All reads reuse the same
  // location-scoping + visible-window rules as the live endpoints. Enforcement
  // actions reuse the existing enforcer-only boot lifecycle and never bypass
  // role checks.
  if (process.env.ENABLE_ENFORCER_MOBILE_PREVIEW === "1") {
    registerEnforcerPreviewRoutes(app);
  }

  return httpServer;
}

// ---------------------------------------------------------------------------
// Enforcer Mobile Preview route registration (kept in a separate function so
// the live route block above is visually unchanged). Reuses module-scoped
// helpers: actorOf, allowedLocationIds, resolvePaidCars, todayKey, requireRole.
// ---------------------------------------------------------------------------
function registerEnforcerPreviewRoutes(app: Express) {
  // Derive the richer lifecycle stage for a boot from existing data + the
  // optional persisted hint. `paidPlates` is the normalized set of plates that
  // paid (Stripe + manual) for the relevant day.
  function deriveStage(
    boot: { status: string; enforcementStage: string | null; licensePlate: string },
    paidPlates: Set<string>,
  ): EnforcementStage {
    const hint = boot.enforcementStage as EnforcementStage | null;
    // A stored hint wins only when it is still consistent with live status.
    if (hint && ENFORCEMENT_STAGES.includes(hint)) {
      // payment_pending / reopened / review_needed are hint-only states that
      // sit "on top of" an active (booted) record.
      if (
        (hint === "payment_pending" ||
          hint === "reopened" ||
          hint === "review_needed") &&
        boot.status === "booted"
      ) {
        return hint;
      }
    }
    switch (boot.status) {
      case "released":
        return "released";
      case "settled":
        return "paid";
      case "completed":
        return "completed";
      case "booted":
      default:
        return "booted";
    }
  }

  // GET /api/preview/enforcer/cases?date=YYYY-MM-DD&tz=<min>
  // Active + recent enforcement cases for the enforcer's lots, enriched with a
  // derived lifecycle stage and live paid status for the requested day.
  app.get(
    "/api/preview/enforcer/cases",
    requireRole("enforcer", "admin"),
    async (req, res) => {
      const tz = Number(req.query.tz ?? 0) || 0;
      const date = String(req.query.date || todayKey(tz));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: "date must be YYYY-MM-DD" });
      }
      let boots = await storage.getBoots();
      const allowed = await allowedLocationIds(req);
      if (allowed) {
        const allowedSet = new Set(allowed);
        boots = boots.filter(
          (b) => b.locationId == null || allowedSet.has(b.locationId),
        );
      }
      // Live paid plates for the day (best-effort; tolerate Stripe hiccups).
      let paidPlates = new Set<string>();
      let stripeOk = true;
      try {
        const { cars } = await resolvePaidCars(date, tz);
        paidPlates = new Set(
          cars.map((p) => normalizePlate(p.licensePlate)).filter(Boolean),
        );
      } catch {
        // Stripe (or the snapshot fallback) failed: payment data is stale.
        // The UI shows a stale-Stripe banner and suppresses paid hints.
        stripeOk = false;
      }
      const cases = boots.map((b) => {
        const np = normalizePlate(b.licensePlate);
        const stage = deriveStage(b, paidPlates);
        return {
          id: b.id,
          licensePlate: b.licensePlate,
          makeModel: b.makeModel,
          color: b.color,
          bootedAt: b.bootedAt,
          bootFee: b.bootFee,
          amountCollected: b.amountCollected,
          status: b.status,
          stage,
          locationId: b.locationId,
          photos: b.photos,
          // Guardrail signal: this booted plate appears paid for the day.
          paidConflict: stage === "booted" && paidPlates.has(np),
          lastActionByName: b.lastActionByName,
        };
      });
      res.json({ date, cases, stripeOk });
    },
  );

  // GET /api/preview/enforcer/paid-cars-range?days=30&tz=<min>
  // Flat list of every car paid (Stripe + manual) across the trailing window —
  // powers the enforcer Lookup page so a plate can be matched against up to 30
  // days of payment history (not just today). Past days serve their stored
  // snapshot; today is fetched live. Staff are clamped to their visible window.
  app.get(
    "/api/preview/enforcer/paid-cars-range",
    requireRole("enforcer", "admin"),
    async (req, res) => {
      const tz = Number(req.query.tz ?? 0) || 0;
      const requested = Number(req.query.days ?? 30);
      let dayCount =
        Number.isFinite(requested) && requested > 0
          ? Math.min(30, Math.floor(requested))
          : 30;

      // Clamp staff to their visible window (admins see the full 30 days).
      const cutoff = await staffVisibleCutoffDay(req, tz);
      if (cutoff) {
        const { historyVisibleDays } = await storage.getSettings();
        dayCount = Math.min(dayCount, historyVisibleDays + 1);
      }

      const today = todayKey(tz);
      const [ty, tm, td] = today.split("-").map(Number);
      const days: string[] = [];
      for (let i = 0; i < dayCount; i++) {
        const dt = new Date(Date.UTC(ty, tm - 1, td) - i * 86400000);
        days.push(dt.toISOString().slice(0, 10));
      }

      // Aggregate per-day paid cars into one flat, de-duped list. Best-effort:
      // a Stripe hiccup on any single day is tolerated (that day contributes
      // whatever snapshot/manual rows it has) and flagged via stripeOk.
      const cars: Array<{
        id: string;
        licensePlate: string;
        makeModel: string;
        color: string | null;
        paidAt: string;
        source: "stripe" | "manual";
      }> = [];
      const seen = new Set<string>();
      let stripeOk = true;
      for (const day of days) {
        try {
          const { cars: dayCars } = await resolvePaidCars(day, tz);
          for (const c of dayCars) {
            const key = c.id || `${normalizePlate(c.licensePlate)}_${c.paidAt}`;
            if (seen.has(key)) continue;
            seen.add(key);
            cars.push({
              id: String(c.id),
              licensePlate: c.licensePlate,
              makeModel: c.makeModel,
              color: c.color,
              paidAt: c.paidAt,
              source: c.source === "manual" ? "manual" : "stripe",
            });
          }
        } catch {
          stripeOk = false;
        }
      }
      cars.sort((a, b) => (b.paidAt || "").localeCompare(a.paidAt || ""));
      res.json({ cars, days: dayCount, stripeOk });
    },
  );

  // GET /api/preview/enforcer/case/:id — single case + append-only timeline.
  app.get(
    "/api/preview/enforcer/case/:id",
    requireRole("enforcer", "admin"),
    async (req, res) => {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const boot = (await storage.getBoots()).find((b) => b.id === id);
      if (!boot) return res.status(404).json({ message: "Case not found" });
      const allowed = await allowedLocationIds(req);
      if (
        allowed &&
        boot.locationId != null &&
        !allowed.includes(boot.locationId)
      ) {
        return res
          .status(403)
          .json({ message: "This case is not at one of your lots." });
      }
      const events = await storage.getEnforcementEvents(id);
      let evidenceLabels: unknown = [];
      try {
        evidenceLabels = JSON.parse(boot.evidenceLabels || "[]");
      } catch {
        evidenceLabels = [];
      }

      // Derive the case stage exactly like the list endpoint so the detail view
      // shows the right actions. Resolve paid plates best-effort for the boot's
      // day; tolerate Stripe hiccups (the stage just won't reflect a paid hint).
      const tz = Number(req.query.tz) || 0;
      const day = (boot.bootedAt || "").slice(0, 10) || todayKey(tz);
      let paidPlates = new Set<string>();
      let stripeOk = true;
      try {
        const { cars } = await resolvePaidCars(day, tz);
        paidPlates = new Set(
          cars.map((p) => normalizePlate(p.licensePlate)).filter(Boolean),
        );
      } catch {
        stripeOk = false;
      }
      const stage = deriveStage(boot, paidPlates);
      const np = normalizePlate(boot.licensePlate);

      // Shape the case to match the list endpoint (parsed arrays + derived
      // fields) so the frontend reads stage/photos/evidence consistently.
      const shapedCase = {
        ...boot,
        stage,
        evidenceLabels,
        paidConflict: stage === "booted" && paidPlates.has(np),
        stripeOk,
      };
      res.json({ case: shapedCase, events, evidenceLabels });
    },
  );

  // POST /api/preview/enforcer/case/:id/action
  // Advance a case to a new stage. Persists the stage hint + evidence labels,
  // appends an audit event, and mirrors to the live boot status when the stage
  // maps onto one (paid/completed/released/reopened) — reusing the same write
  // path the live enforcer already has.
  app.post(
    "/api/preview/enforcer/case/:id/action",
    requireRole("enforcer", "admin"),
    async (req, res) => {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const parsed = enforcementActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ message: fromZodError(parsed.error).toString() });
      }
      const boot = (await storage.getBoots()).find((b) => b.id === id);
      if (!boot) return res.status(404).json({ message: "Case not found" });
      const allowed = await allowedLocationIds(req);
      if (
        allowed &&
        boot.locationId != null &&
        !allowed.includes(boot.locationId)
      ) {
        return res
          .status(403)
          .json({ message: "This case is not at one of your lots." });
      }
      const { stage, note, evidenceLabels, amountCollected } = parsed.data;
      const actor = actorOf(req);
      const fee = boot.bootFee ?? 0;

      // Mirror to the live boot lifecycle where the stage has a canonical status.
      if (stage === "completed") {
        await storage.updateBootStatus(
          id,
          "completed",
          amountCollected != null ? amountCollected : fee,
          new Date().toISOString(),
          actor,
        );
      } else if (stage === "paid") {
        // "paid" with a partial amount = settled; full/none = completed.
        if (amountCollected != null && amountCollected > 0 && amountCollected < fee) {
          await storage.updateBootStatus(
            id,
            "settled",
            amountCollected,
            new Date().toISOString(),
            actor,
          );
        } else {
          await storage.updateBootStatus(
            id,
            "completed",
            amountCollected != null ? amountCollected : fee,
            new Date().toISOString(),
            actor,
          );
        }
      } else if (stage === "released") {
        await storage.updateBootStatus(id, "released", 0, new Date().toISOString(), actor);
      } else if (stage === "reopened" || stage === "booted") {
        await storage.updateBootStatus(id, "booted", 0, null, actor);
      }

      // Persist the stage hint (for hint-only states) + any evidence labels.
      const hintStages: EnforcementStage[] = [
        "payment_pending",
        "reopened",
        "review_needed",
      ];
      const enforcementStage = hintStages.includes(stage) ? stage : null;
      const evidencePatch =
        evidenceLabels != null ? JSON.stringify(evidenceLabels) : undefined;
      const updated = await storage.setBootEnforcement(
        id,
        { enforcementStage, ...(evidencePatch !== undefined ? { evidenceLabels: evidencePatch } : {}) },
        actor,
      );

      // Append the immutable audit event.
      await storage.addEnforcementEvent({
        bootId: id,
        stage,
        note: note ?? null,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
        createdAt: new Date().toISOString(),
      });

      const fresh = (await storage.getBoots()).find((b) => b.id === id) ?? updated;
      const events = await storage.getEnforcementEvents(id);
      res.json({ case: fresh, events });
    },
  );

  // =========================================================================
  // Admin Mobile Management Preview API (preview-only, admin-only, additive)
  // =========================================================================
  // A single aggregating call that powers the mobile admin dashboard: daily
  // totals, live active-count trackers, this-month rollup, a 7-day trend, and
  // the full recent-activity feed. Admin-only — gives complete visibility.
  // GET /api/preview/admin/overview?tz=<offsetMinutes>
  app.get(
    "/api/preview/admin/overview",
    requireRole("admin"),
    async (req, res) => {
      const tz = Number(req.query.tz ?? 0) || 0;
      const today = todayKey(tz);
      const cacheKey = `${today}|${tz}`;

      // Heavy assembly: 6 parallel Supabase reads + the live Stripe pass. Wrapped
      // so it can run inline (cold) or in the background (stale-while-revalidate).
      const buildOverview = async () => {
      const [boots, users, locations, bootReqs, releaseReqs, cash] =
        await Promise.all([
          // Overview never needs boot photos; skip the heavy base64 column so
          // the payload stays small enough for the published-sandbox proxy.
          storage.getBootsForOverview(),
          storage.getUsers(),
          storage.getLocations(),
          storage.getBootRequestsForOverview(),
          storage.getReleaseRequests(),
          storage.getAllCashCollections(),
        ]);

      // Live paid plates for today (best-effort; tolerate Stripe hiccups).
      let paidPlates = new Set<string>();
      let paidTodayCount = 0; // total parked cars today (Stripe + manual)
      let paidStripeCount = 0; // Stripe-only paid cars today
      let paidCarsList: {
        id: string;
        licensePlate: string;
        makeModel: string;
        color: string | null;
        paidAt: string;
        source: "manual" | "stripe";
        amount: number | null;
        method: "cash" | "card" | "app" | null;
        space: string | null;
      }[] = [];
      let stripeOk = true;
      try {
        // resolvePaidCars already self-bounds the live Stripe pass and falls
        // back to the stored snapshot on timeout, so this resolves quickly. The
        // try/catch remains as a final safety net (stripeOk=false) for any
        // unexpected error so the rest of the dashboard still renders.
        const { cars } = await resolvePaidCars(today, tz);
        paidTodayCount = cars.length;
        paidStripeCount = cars.filter((c) => c.source === "stripe").length;
        paidPlates = new Set(
          cars.map((p) => normalizePlate(p.licensePlate)).filter(Boolean),
        );
        // Newest first, capped — powers the "Paid cars" list toggle.
        paidCarsList = [...cars]
          .sort((a, b) => (b.paidAt || "").localeCompare(a.paidAt || ""))
          .slice(0, 40)
          .map((c) => ({
            id: c.id,
            licensePlate: c.licensePlate,
            makeModel: c.makeModel,
            color: c.color ?? null,
            paidAt: c.paidAt,
            source: c.source,
            amount: c.amount ?? null,
            method: c.method ?? null,
            space: c.space ?? null,
          }));
      } catch {
        stripeOk = false;
      }

      const dayOf = (iso: string) => localDayKey(iso, tz);

      // ---- Today's totals -------------------------------------------------
      const todayBoots = boots.filter((b) => dayOf(b.bootedAt) === today);
      const bootedToday = todayBoots.length;
      const collectedToday = boots
        .filter((b) => b.resolvedAt && dayOf(b.resolvedAt) === today)
        .reduce((s, b) => s + (b.amountCollected ?? 0), 0);
      const resolvedToday = boots.filter(
        (b) =>
          b.resolvedAt &&
          dayOf(b.resolvedAt) === today &&
          (b.status === "completed" ||
            b.status === "settled" ||
            b.status === "released"),
      ).length;

      // ---- Active-count trackers (live, not date-bound) -------------------
      const activeBoots = boots.filter(
        (b) => (b.status ?? "booted") === "booted",
      );
      const activeCount = activeBoots.length;
      // Booted plates that appear paid for today = conflicts needing review.
      const needsReview = activeBoots.filter((b) =>
        paidPlates.has(normalizePlate(b.licensePlate)),
      ).length;
      const pendingRequests = bootReqs.filter(
        (r) => r.status === "pending",
      ).length;
      const pendingReleases = releaseReqs.filter(
        (r) => r.status === "pending",
      ).length;

      // ---- This-month rollup ---------------------------------------------
      let monthCount = 0;
      let monthCollected = 0;
      const ym = today.slice(0, 7); // YYYY-MM in local tz
      for (const b of boots) {
        if (dayOf(b.bootedAt).slice(0, 7) === ym) monthCount += 1;
      }
      for (const b of boots) {
        if (b.resolvedAt && dayOf(b.resolvedAt).slice(0, 7) === ym) {
          monthCollected += b.amountCollected ?? 0;
        }
      }

      // ---- Cash ledger (org-wide attendant cash reconciliation) ----------
      // "Cash owed to bank" = unreconciled cash attendants are still holding
      // (hasn't been physically deposited / handed to the admin yet).
      // "Cash tracker" = the running ledger: owed vs already reconciled,
      // plus per-collector breakdown and today's cash intake.
      let cashOwedTotal = 0;
      let cashOwedCount = 0;
      let cashReconciledTotal = 0;
      let cashCollectedToday = 0;
      // All manual cash payments (verified + unverified) — drives the
      // "Cash Payments Tracker" tile in the Today section.
      let cashAllTotal = 0;
      let cashAllCount = 0;
      // Each holder carries the list of their unverified entries so the admin
      // dashboard can expand a row and verify individual entries inline
      // (per-entry checkboxes) without a second round-trip.
      type HolderEntry = {
        id: number;
        licensePlate: string;
        makeModel: string;
        amount: number;
        collectedAt: string;
      };
      const byCollector = new Map<
        number,
        {
          id: number;
          name: string;
          owed: number;
          count: number;
          entries: HolderEntry[];
        }
      >();
      for (const c of cash) {
        const amt = Number(c.amount) || 0;
        cashAllTotal += amt;
        cashAllCount += 1;
        if (c.day === today || dayOf(c.collectedAt) === today) {
          cashCollectedToday += amt;
        }
        if (c.reconciled) {
          cashReconciledTotal += amt;
        } else {
          cashOwedTotal += amt;
          cashOwedCount += 1;
          const prev =
            byCollector.get(c.collectedById) ?? {
              id: c.collectedById,
              name: c.collectedByName || "Attendant",
              owed: 0,
              count: 0,
              entries: [] as HolderEntry[],
            };
          prev.owed += amt;
          prev.count += 1;
          prev.name = c.collectedByName || prev.name;
          prev.entries.push({
            id: c.id,
            licensePlate: c.licensePlate,
            makeModel: c.makeModel || "",
            amount: Math.round(amt * 100) / 100,
            collectedAt: c.collectedAt,
          });
          byCollector.set(c.collectedById, prev);
        }
      }
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const cashHolders = [...byCollector.values()]
        .map((h) => ({
          ...h,
          owed: round2(h.owed),
          // Newest entry first within each holder.
          entries: h.entries.sort((a, b) =>
            (b.collectedAt || "").localeCompare(a.collectedAt || ""),
          ),
        }))
        .sort((a, b) => b.owed - a.owed);
      // Recent cash = EVERY manual cash payment from the last 30 days (verified
      // + unverified), newest first. No row cap — the admin "Recent cash" tab
      // renders this in a scrollable, searchable, date-filterable table. Bound
      // by a 30-day window so the payload stays proxy-safe while still giving
      // the admin a full month of history to search.
      const recentCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recentCash = cash
        .filter((c) => {
          const t = Date.parse(c.collectedAt || "");
          return Number.isNaN(t) ? true : t >= recentCutoffMs;
        })
        .map((c) => ({
          id: c.id,
          licensePlate: c.licensePlate,
          makeModel: c.makeModel || "",
          amount: round2(Number(c.amount) || 0),
          collectedByName: c.collectedByName || "Attendant",
          collectedAt: c.collectedAt,
          reconciled: c.reconciled,
        }));

      // ---- 7-day trend (oldest -> newest) --------------------------------
      const trend: { day: string; booted: number; collected: number; isToday: boolean }[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = dayMinus(today, i);
        const booted = boots.filter((b) => dayOf(b.bootedAt) === d).length;
        const collected = boots
          .filter((b) => b.resolvedAt && dayOf(b.resolvedAt) === d)
          .reduce((s, b) => s + (b.amountCollected ?? 0), 0);
        trend.push({ day: d, booted, collected, isToday: d === today });
      }

      // ---- Recent activity feed (full data, newest first, capped) --------
      const recent = [...boots]
        .sort((a, b) => (b.bootedAt || "").localeCompare(a.bootedAt || ""))
        .slice(0, 40)
        .map((b) => {
          const stage = deriveStage(b, paidPlates);
          return {
            id: b.id,
            licensePlate: b.licensePlate,
            makeModel: b.makeModel,
            color: b.color,
            bootedAt: b.bootedAt,
            resolvedAt: b.resolvedAt,
            bootFee: b.bootFee,
            amountCollected: b.amountCollected,
            status: b.status,
            stage,
            locationId: b.locationId,
            paidConflict:
              stage === "booted" &&
              paidPlates.has(normalizePlate(b.licensePlate)),
            lastActionByName: b.lastActionByName,
          };
        });

      const payload = {
        date: today,
        stripeOk,
        today: {
          booted: bootedToday,
          collected: collectedToday,
          resolved: resolvedToday,
          // parkedTotal = total parked cars today (Stripe + manual)
          parkedTotal: paidTodayCount,
          // paidStripe = Stripe-only paid cars today
          paidStripe: paidStripeCount,
          // cashPaymentsTotal = all manual cash payments (verified + unverified)
          cashPaymentsTotal: round2(cashAllTotal),
          cashPaymentsCount: cashAllCount,
        },
        active: {
          boots: activeCount,
          needsReview,
          pendingRequests,
          pendingReleases,
        },
        cash: {
          owedToBank: round2(cashOwedTotal),
          owedCount: cashOwedCount,
          reconciledTotal: round2(cashReconciledTotal),
          collectedToday: round2(cashCollectedToday),
          allTotal: round2(cashAllTotal),
          allCount: cashAllCount,
          holders: cashHolders,
          recent: recentCash,
        },
        month: {
          label: ym,
          booted: monthCount,
          collected: monthCollected,
        },
        trend,
        recent,
        paidCars: paidCarsList,
        staff: {
          total: users.length,
          active: users.filter((u) => u.active).length,
          enforcers: users.filter((u) => u.role === "enforcer").length,
          attendants: users.filter((u) => u.role === "attendant").length,
        },
        locations: {
          total: locations.length,
          active: locations.filter((l) => l.active).length,
          list: locations.map((l) => ({
            id: l.id,
            name: l.name,
            active: l.active,
          })),
        },
      };
      // Only cache healthy responses — never pin a degraded (stripeOk=false)
      // payload, so a transient Stripe hiccup recovers on the next request.
      if (stripeOk) {
        overviewCache.set(cacheKey, { at: Date.now(), payload });
      }
      return payload;
      }; // end buildOverview

      // Kick off a background rebuild (deduped per key) without blocking.
      const refreshInBackground = () => {
        if (overviewRefreshing.has(cacheKey)) return;
        overviewRefreshing.add(cacheKey);
        buildOverview()
          .catch(() => {})
          .finally(() => overviewRefreshing.delete(cacheKey));
      };

      // Stale-while-revalidate: serve fresh instantly; serve recent-stale
      // instantly while refreshing in the background; otherwise build inline.
      const cached = overviewCache.get(cacheKey);
      const age = cached ? Date.now() - cached.at : Infinity;
      if (cached && age < OVERVIEW_CACHE_TTL_MS) {
        return res.json(cached.payload);
      }
      if (cached && age < OVERVIEW_STALE_MAX_MS) {
        refreshInBackground();
        return res.json(cached.payload);
      }
      // Cold path (no usable cache): build synchronously.
      try {
        const payload = await buildOverview();
        res.json(payload);
      } catch (err) {
        // Last-resort fallback: serve any cached payload, however old.
        if (cached) return res.json(cached.payload);
        throw err;
      }
    },
  );
}
