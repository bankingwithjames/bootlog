import {
  HISTORY_VISIBLE_DAYS_DEFAULT,
  HISTORY_VISIBLE_DAYS_MIN,
  HISTORY_VISIBLE_DAYS_MAX,
  SHOW_FINANCIALS_TO_STAFF_DEFAULT,
} from "@shared/schema";
import type {
  Boot,
  InsertBoot,
  PaidSnapshot,
  InsertPaidSnapshot,
  User,
  Role,
  BootRequest,
  InsertBootRequest,
  ReleaseRequest,
  InsertReleaseRequest,
  AppSettings,
  Location,
  LocationWithStaff,
  InsertLocation,
  UpdateLocationInput,
  Shift,
  CashCollection,
  InsertCashCollection,
  CashSummary,
  EnforcementEvent,
} from "@shared/schema";
import { supabase } from "./supabase";
import { hashPassword } from "./auth";

// ---------------------------------------------------------------------------
// Supabase-backed storage.
// ---------------------------------------------------------------------------
// Replaces the previous SQLite (better-sqlite3 + Drizzle) layer so all data —
// users, sessions, boots, requests, paid snapshots, settings — lives in
// Supabase Postgres and persists across sign-outs, sleep, and redeploys.
//
// Supabase/Postgres uses snake_case columns; the app uses camelCase types.
// The row<->object mappers below translate in both directions.
// ---------------------------------------------------------------------------

function parsePhotos(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((p) => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

// ---- Row mappers (DB snake_case row -> API camelCase shape) ----
function rowToUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
  };
}

function rowToUserWithHash(row: any): User & { passwordHash: string } {
  return { ...rowToUser(row), passwordHash: row.password_hash };
}

function rowToBoot(row: any): Boot {
  return {
    id: row.id,
    licensePlate: row.license_plate,
    makeModel: row.make_model,
    color: row.color ?? null,
    bootedAt: row.booted_at,
    bootFee: row.boot_fee ?? 0,
    amountCollected: row.amount_collected ?? 0,
    status: row.status,
    resolvedAt: row.resolved_at ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    photos: parsePhotos(row.photos),
    createdById: row.created_by_id ?? null,
    createdByName: row.created_by_name ?? "",
    lastActionById: row.last_action_by_id ?? null,
    lastActionByName: row.last_action_by_name ?? null,
    feePaid: row.fee_paid ?? 0,
    locationId: row.location_id ?? null,
    // Enforcer Mobile Preview (additive; null on existing rows).
    enforcementStage: row.enforcement_stage ?? null,
    evidenceLabels: row.evidence_labels ?? null,
  } as Boot;
}

function rowToLocation(row: any): Location {
  return {
    id: row.id,
    name: row.name,
    address: row.address ?? "",
    color: row.color ?? "#378ADD",
    active: Boolean(row.active),
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    geofenceRadius: row.geofence_radius ?? 150,
    createdAt: row.created_at,
  } as Location;
}

function rowToShift(row: any): Shift {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name ?? "",
    locationId: row.location_id,
    locationName: row.location_name ?? "",
    checkInAt: row.check_in_at,
    checkOutAt: row.check_out_at ?? null,
    checkInLat: row.check_in_lat ?? null,
    checkInLng: row.check_in_lng ?? null,
    checkOutLat: row.check_out_lat ?? null,
    checkOutLng: row.check_out_lng ?? null,
    geofenceVerified: Boolean(row.geofence_verified),
  } as Shift;
}

function rowToRequest(row: any): BootRequest {
  return {
    id: row.id,
    licensePlate: row.license_plate,
    makeModel: row.make_model,
    color: row.color ?? null,
    suggestedFee: row.suggested_fee ?? 0,
    note: row.note ?? "",
    photos: parsePhotos(row.photos),
    status: row.status,
    requestedById: row.requested_by_id ?? null,
    requestedByName: row.requested_by_name ?? "",
    requestedAt: row.requested_at,
    resolvedById: row.resolved_by_id ?? null,
    resolvedByName: row.resolved_by_name ?? null,
    resolvedAt: row.resolved_at ?? null,
    bootId: row.boot_id ?? null,
  } as BootRequest;
}

function rowToReleaseRequest(row: any): ReleaseRequest {
  return {
    id: row.id,
    bootId: row.boot_id,
    licensePlate: row.license_plate,
    makeModel: row.make_model,
    note: row.note ?? "",
    status: row.status,
    requestedById: row.requested_by_id ?? null,
    requestedByName: row.requested_by_name ?? "",
    requestedAt: row.requested_at,
    resolvedById: row.resolved_by_id ?? null,
    resolvedByName: row.resolved_by_name ?? null,
    resolvedAt: row.resolved_at ?? null,
    locationId: row.location_id ?? null,
  } as ReleaseRequest;
}

function rowToCashCollection(row: any): CashCollection {
  return {
    id: row.id,
    day: row.day,
    snapshotSessionId: row.snapshot_session_id ?? null,
    licensePlate: row.license_plate,
    makeModel: row.make_model ?? "",
    amount: row.amount ?? 0,
    collectedById: row.collected_by_id,
    collectedByName: row.collected_by_name ?? "",
    collectedAt: row.collected_at,
    reconciled: Boolean(row.reconciled),
    reconciledAt: row.reconciled_at ?? null,
    reconciledByName: row.reconciled_by_name ?? null,
    voided: Boolean(row.voided),
    voidedAt: row.voided_at ?? null,
    voidedByName: row.voided_by_name ?? null,
  } as CashCollection;
}

function rowToSnapshot(row: any): PaidSnapshot {
  return {
    id: row.id,
    day: row.day,
    sessionId: row.session_id,
    licensePlate: row.license_plate,
    normalizedPlate: row.normalized_plate,
    makeModel: row.make_model,
    color: row.color,
    paidAt: row.paid_at,
    source: row.source ?? "stripe",
    amount: row.amount ?? null,
    method: row.method ?? null,
    space: row.space ?? null,
  } as PaidSnapshot;
}

// Throw on a Supabase error so routes surface a 500 instead of silent bad data.
function check<T>(res: { data: T; error: any }, ctx: string): T {
  if (res.error) {
    throw new Error(`[storage] ${ctx}: ${res.error.message ?? res.error}`);
  }
  return res.data;
}

// Lightweight actor descriptor recorded on audited mutations.
export type Actor = { id: number; name: string };

export interface IStorage {
  // Users
  getUsers(): Promise<User[]>;
  getUserById(id: number): Promise<User | undefined>;
  getUserByUsername(
    username: string,
  ): Promise<(User & { passwordHash: string }) | undefined>;
  createUser(input: {
    username: string;
    name: string;
    password: string;
    role: Role;
  }): Promise<User>;
  updateUser(
    id: number,
    patch: { name?: string; password?: string; role?: Role; active?: boolean },
  ): Promise<User | undefined>;
  setOwnPassword(id: number, newPassword: string): Promise<User | undefined>;
  countActiveAdmins(): Promise<number>;
  // Boots
  getBoots(): Promise<Boot[]>;
  // getBoots without the heavy photos column — for dashboards/rollups.
  getBootsForOverview(): Promise<Boot[]>;
  createBoot(boot: InsertBoot, actor?: Actor): Promise<Boot>;
  updateBootStatus(
    id: number,
    status: string,
    amountCollected: number,
    resolvedAt: string | null,
    actor?: Actor,
  ): Promise<Boot | undefined>;
  deleteBoot(id: number): Promise<{ changes: number }>;
  // Enforcer Mobile Preview (additive): persist a stage hint + evidence labels
  // on a boot, and append an immutable audit-timeline event.
  setBootEnforcement(
    id: number,
    patch: { enforcementStage?: string | null; evidenceLabels?: string | null },
    actor?: Actor,
  ): Promise<Boot | undefined>;
  addEnforcementEvent(input: {
    bootId: number | null;
    requestId?: number | null;
    stage: string;
    note?: string | null;
    actorId?: number | null;
    actorName?: string | null;
    createdAt: string;
  }): Promise<EnforcementEvent>;
  getEnforcementEvents(bootId: number): Promise<EnforcementEvent[]>;
  // Parking locations (multi-location support)
  getLocations(): Promise<LocationWithStaff[]>;
  createLocation(input: InsertLocation): Promise<LocationWithStaff>;
  updateLocation(
    id: number,
    patch: UpdateLocationInput,
  ): Promise<LocationWithStaff | undefined>;
  // Auto-detected geofence center for a location (geocoded from its address).
  setLocationGeofenceCenter(
    id: number,
    latitude: number,
    longitude: number,
  ): Promise<Location | undefined>;
  // Staff<->location assignments
  getLocationIdsForUser(userId: number): Promise<number[]>;
  setStaffForLocation(locationId: number, staffIds: number[]): Promise<void>;
  // Shifts (geofenced check-in / check-out)
  getActiveShiftForUser(userId: number): Promise<Shift | undefined>;
  createShift(input: {
    userId: number;
    userName: string;
    locationId: number;
    locationName: string;
    checkInLat: number;
    checkInLng: number;
    geofenceVerified: boolean;
  }): Promise<Shift>;
  closeShift(
    id: number,
    checkOutLat: number | null,
    checkOutLng: number | null,
  ): Promise<Shift | undefined>;
  getShiftById(id: number): Promise<Shift | undefined>;
  // A user's own shift history (timesheet), newest first.
  getShiftsForUser(userId: number, limit?: number): Promise<Shift[]>;
  // Cash collections (attendant cash ledger)
  addCashCollection(row: InsertCashCollection): Promise<CashCollection>;
  getCashForCollector(collectorId: number): Promise<CashCollection[]>;
  getCashSummaryForCollector(collectorId: number): Promise<CashSummary>;
  // Org-wide cash ledger (admin reconciliation view), newest first.
  getAllCashCollections(): Promise<CashCollection[]>;
  // Admin verifies + collects cash: flip the given entries to reconciled,
  // stamping who approved and when. Only entries that are currently
  // unreconciled are updated. Returns the updated rows.
  reconcileCashCollections(
    ids: number[],
    reconciledByName: string,
  ): Promise<CashCollection[]>;
  // Admin soft-deletes (voids) a single cash entry. The row is kept for audit
  // but excluded from all totals/lists. Returns the updated row or null.
  voidCashCollection(
    id: number,
    voidedByName: string,
  ): Promise<CashCollection | null>;
  // Boot requests
  getBootRequests(): Promise<BootRequest[]>;
  getBootRequestsForOverview(): Promise<BootRequest[]>;
  getBootRequest(id: number): Promise<BootRequest | undefined>;
  createBootRequest(
    input: InsertBootRequest,
    requester: Actor,
  ): Promise<BootRequest>;
  resolveBootRequest(
    id: number,
    status: "initiated" | "dismissed",
    resolver: Actor,
    bootId: number | null,
  ): Promise<BootRequest | undefined>;
  // Release requests (attendant -> enforcer to remove a boot)
  getReleaseRequests(): Promise<ReleaseRequest[]>;
  createReleaseRequest(
    input: { bootId: number; note: string },
    boot: { licensePlate: string; makeModel: string; locationId: number | null },
    requester: Actor,
  ): Promise<ReleaseRequest>;
  // Paid-car snapshots
  getSnapshotsForDay(day: string): Promise<PaidSnapshot[]>;
  getManualSnapshotsForDay(day: string): Promise<PaidSnapshot[]>;
  hasSnapshotForDay(day: string): Promise<boolean>;
  replaceSnapshotsForDay(
    day: string,
    rows: InsertPaidSnapshot[],
  ): Promise<void>;
  addManualSnapshot(row: InsertPaidSnapshot): Promise<PaidSnapshot>;
  deleteManualSnapshot(sessionId: string): Promise<{ changes: number }>;
  getAllSnapshots(): Promise<PaidSnapshot[]>;
  // Retention
  pruneOlderThan(cutoffDay: string, cutoffIso: string): Promise<void>;
  // Settings
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}

export class DatabaseStorage implements IStorage {
  // ---- Users ----
  async getUsers(): Promise<User[]> {
    const rows = check(
      await supabase
        .from("users")
        .select("*")
        .order("created_at", { ascending: false }),
      "getUsers",
    );
    return (rows ?? []).map(rowToUser);
  }

  async getUserById(id: number): Promise<User | undefined> {
    const rows = check(
      await supabase.from("users").select("*").eq("id", id).limit(1),
      "getUserById",
    );
    const row = (rows ?? [])[0];
    return row ? rowToUser(row) : undefined;
  }

  async getUserByUsername(
    username: string,
  ): Promise<(User & { passwordHash: string }) | undefined> {
    // Case-insensitive lookup (ilike with no wildcards == exact, ci match).
    const rows = check(
      await supabase
        .from("users")
        .select("*")
        .ilike("username", username)
        .limit(1),
      "getUserByUsername",
    );
    const row = (rows ?? [])[0];
    return row ? rowToUserWithHash(row) : undefined;
  }

  async createUser(input: {
    username: string;
    name: string;
    password: string;
    role: Role;
  }): Promise<User> {
    const row = check(
      await supabase
        .from("users")
        .insert({
          username: input.username,
          name: input.name,
          password_hash: hashPassword(input.password),
          role: input.role,
          active: true,
          // Admin sets an initial password; require the new user to pick their
          // own on first login so the admin never knows their standing password.
          must_change_password: true,
          created_at: new Date().toISOString(),
        })
        .select("*")
        .single(),
      "createUser",
    );
    return rowToUser(row);
  }

  async updateUser(
    id: number,
    patch: { name?: string; password?: string; role?: Role; active?: boolean },
  ): Promise<User | undefined> {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.active !== undefined) set.active = patch.active;
    if (patch.password) {
      set.password_hash = hashPassword(patch.password);
      // An admin-set password is temporary: force the target to choose their
      // own on next login.
      set.must_change_password = true;
    }
    if (Object.keys(set).length === 0) return this.getUserById(id);
    const rows = check(
      await supabase.from("users").update(set).eq("id", id).select("*"),
      "updateUser",
    );
    const row = (rows ?? [])[0];
    return row ? rowToUser(row) : undefined;
  }

  async setOwnPassword(
    id: number,
    newPassword: string,
  ): Promise<User | undefined> {
    const rows = check(
      await supabase
        .from("users")
        .update({
          password_hash: hashPassword(newPassword),
          must_change_password: false,
        })
        .eq("id", id)
        .select("*"),
      "setOwnPassword",
    );
    const row = (rows ?? [])[0];
    return row ? rowToUser(row) : undefined;
  }

  async countActiveAdmins(): Promise<number> {
    const res = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("active", true);
    if (res.error) {
      throw new Error(`[storage] countActiveAdmins: ${res.error.message}`);
    }
    return res.count ?? 0;
  }

  // ---- Boot requests ----
  async getBootRequests(): Promise<BootRequest[]> {
    const rows = check(
      await supabase
        .from("boot_requests")
        .select("*")
        .order("requested_at", { ascending: false }),
      "getBootRequests",
    );
    return (rows ?? []).map(rowToRequest);
  }

  // Overview never needs boot-request photos. The photos column stores inline
  // base64 images (multiple MB per row), so selecting it for every request
  // blows the Postgres statement timeout and the published-sandbox proxy
  // budget. Skip it here; returned requests carry photos: [].
  async getBootRequestsForOverview(): Promise<BootRequest[]> {
    const cols =
      "id, license_plate, make_model, color, suggested_fee, note, status, " +
      "requested_by_id, requested_by_name, requested_at, resolved_by_id, " +
      "resolved_by_name, resolved_at, boot_id";
    const rows = check(
      await supabase
        .from("boot_requests")
        .select(cols)
        .order("requested_at", { ascending: false }),
      "getBootRequestsForOverview",
    );
    return (rows ?? []).map(rowToRequest);
  }

  async getBootRequest(id: number): Promise<BootRequest | undefined> {
    const rows = check(
      await supabase.from("boot_requests").select("*").eq("id", id).limit(1),
      "getBootRequest",
    );
    const row = (rows ?? [])[0];
    return row ? rowToRequest(row) : undefined;
  }

  async createBootRequest(
    input: InsertBootRequest,
    requester: Actor,
  ): Promise<BootRequest> {
    const { photos = [], ...rest } = input;
    const row = check(
      await supabase
        .from("boot_requests")
        .insert({
          license_plate: rest.licensePlate,
          make_model: rest.makeModel,
          color: rest.color ?? null,
          suggested_fee: rest.suggestedFee ?? 0,
          note: rest.note ?? "",
          photos: JSON.stringify(photos.slice(0, 5)),
          status: "pending",
          requested_by_id: requester.id,
          requested_by_name: requester.name,
          requested_at: new Date().toISOString(),
        })
        .select("*")
        .single(),
      "createBootRequest",
    );
    return rowToRequest(row);
  }

  async resolveBootRequest(
    id: number,
    status: "initiated" | "dismissed",
    resolver: Actor,
    bootId: number | null,
  ): Promise<BootRequest | undefined> {
    const rows = check(
      await supabase
        .from("boot_requests")
        .update({
          status,
          resolved_by_id: resolver.id,
          resolved_by_name: resolver.name,
          resolved_at: new Date().toISOString(),
          boot_id: bootId,
        })
        .eq("id", id)
        .select("*"),
      "resolveBootRequest",
    );
    const row = (rows ?? [])[0];
    return row ? rowToRequest(row) : undefined;
  }

  // ---- Release requests ----
  async getReleaseRequests(): Promise<ReleaseRequest[]> {
    const rows = check(
      await supabase
        .from("release_requests")
        .select("*")
        .order("requested_at", { ascending: false }),
      "getReleaseRequests",
    );
    return (rows ?? []).map(rowToReleaseRequest);
  }

  async createReleaseRequest(
    input: { bootId: number; note: string },
    boot: { licensePlate: string; makeModel: string; locationId: number | null },
    requester: Actor,
  ): Promise<ReleaseRequest> {
    const row = check(
      await supabase
        .from("release_requests")
        .insert({
          boot_id: input.bootId,
          license_plate: boot.licensePlate,
          make_model: boot.makeModel,
          note: input.note ?? "",
          status: "pending",
          requested_by_id: requester.id,
          requested_by_name: requester.name,
          requested_at: new Date().toISOString(),
          location_id: boot.locationId ?? null,
        })
        .select("*")
        .single(),
      "createReleaseRequest",
    );
    return rowToReleaseRequest(row);
  }

  // ---- Boots ----
  async getBoots(): Promise<Boot[]> {
    const rows = check(
      await supabase
        .from("boots")
        .select("*")
        .order("booted_at", { ascending: false }),
      "getBoots",
    );
    return (rows ?? []).map(rowToBoot);
  }

  // Like getBoots but EXCLUDES the heavy `photos` column (base64 image blobs).
  // Dashboards/rollups never need photos, and fetching them for every boot
  // bloats the payload enough to blow the published-sandbox proxy's request
  // budget (→ empty-body 503). Returned boots carry photos: [].
  async getBootsForOverview(): Promise<Boot[]> {
    const cols =
      "id, license_plate, make_model, color, booted_at, boot_fee, " +
      "amount_collected, status, resolved_at, latitude, longitude, " +
      "created_by_id, created_by_name, last_action_by_id, " +
      "last_action_by_name, fee_paid, location_id, enforcement_stage, " +
      "evidence_labels";
    const rows = check(
      await supabase
        .from("boots")
        .select(cols)
        .order("booted_at", { ascending: false }),
      "getBootsForOverview",
    );
    return (rows ?? []).map(rowToBoot);
  }

  async createBoot(insertBoot: InsertBoot, actor?: Actor): Promise<Boot> {
    const { photos = [], latitude, longitude, color, locationId, ...rest } =
      insertBoot;
    const row = check(
      await supabase
        .from("boots")
        .insert({
          license_plate: rest.licensePlate,
          make_model: rest.makeModel,
          color: color ?? null,
          booted_at: rest.bootedAt,
          boot_fee: rest.bootFee ?? 0,
          status: "booted",
          amount_collected: 0,
          resolved_at: null,
          latitude: latitude ?? null,
          longitude: longitude ?? null,
          photos: JSON.stringify(photos.slice(0, 5)),
          created_by_id: actor?.id ?? null,
          created_by_name: actor?.name ?? "",
          last_action_by_id: actor?.id ?? null,
          last_action_by_name: actor?.name ?? null,
          fee_paid: 0,
          location_id: locationId ?? null,
        })
        .select("*")
        .single(),
      "createBoot",
    );
    return rowToBoot(row);
  }

  async updateBootStatus(
    id: number,
    status: string,
    amountCollected: number,
    resolvedAt: string | null,
    actor?: Actor,
  ): Promise<Boot | undefined> {
    const set: Record<string, unknown> = {
      status,
      amount_collected: amountCollected,
      resolved_at: resolvedAt,
    };
    if (actor) {
      set.last_action_by_id = actor.id;
      set.last_action_by_name = actor.name;
    }
    const rows = check(
      await supabase.from("boots").update(set).eq("id", id).select("*"),
      "updateBootStatus",
    );
    const row = (rows ?? [])[0];
    return row ? rowToBoot(row) : undefined;
  }

  async deleteBoot(id: number): Promise<{ changes: number }> {
    const rows = check(
      await supabase.from("boots").delete().eq("id", id).select("id"),
      "deleteBoot",
    );
    return { changes: (rows ?? []).length };
  }

  // ---- Enforcer Mobile Preview (additive) ----
  async setBootEnforcement(
    id: number,
    patch: { enforcementStage?: string | null; evidenceLabels?: string | null },
    actor?: Actor,
  ): Promise<Boot | undefined> {
    const set: Record<string, unknown> = {};
    if (patch.enforcementStage !== undefined)
      set.enforcement_stage = patch.enforcementStage;
    if (patch.evidenceLabels !== undefined)
      set.evidence_labels = patch.evidenceLabels;
    if (actor) {
      set.last_action_by_id = actor.id;
      set.last_action_by_name = actor.name;
    }
    if (Object.keys(set).length === 0) {
      const existing = (await this.getBoots()).find((b) => b.id === id);
      return existing;
    }
    const rows = check(
      await supabase.from("boots").update(set).eq("id", id).select("*"),
      "setBootEnforcement",
    );
    const row = (rows ?? [])[0];
    return row ? rowToBoot(row) : undefined;
  }

  async addEnforcementEvent(input: {
    bootId: number | null;
    requestId?: number | null;
    stage: string;
    note?: string | null;
    actorId?: number | null;
    actorName?: string | null;
    createdAt: string;
  }): Promise<EnforcementEvent> {
    const row = check(
      await supabase
        .from("enforcement_events")
        .insert({
          boot_id: input.bootId,
          request_id: input.requestId ?? null,
          stage: input.stage,
          note: input.note ?? null,
          actor_id: input.actorId ?? null,
          actor_name: input.actorName ?? null,
          created_at: input.createdAt,
        })
        .select("*")
        .single(),
      "addEnforcementEvent",
    );
    return {
      id: row.id,
      bootId: row.boot_id ?? null,
      requestId: row.request_id ?? null,
      stage: row.stage,
      note: row.note ?? null,
      actorId: row.actor_id ?? null,
      actorName: row.actor_name ?? null,
      createdAt: row.created_at,
    } as EnforcementEvent;
  }

  async getEnforcementEvents(bootId: number): Promise<EnforcementEvent[]> {
    const rows = check(
      await supabase
        .from("enforcement_events")
        .select("*")
        .eq("boot_id", bootId)
        .order("created_at", { ascending: true }),
      "getEnforcementEvents",
    );
    return (rows ?? []).map((row: any) => ({
      id: row.id,
      bootId: row.boot_id ?? null,
      requestId: row.request_id ?? null,
      stage: row.stage,
      note: row.note ?? null,
      actorId: row.actor_id ?? null,
      actorName: row.actor_name ?? null,
      createdAt: row.created_at,
    })) as EnforcementEvent[];
  }

  // ---- Parking locations ----
  // Pull all staff_locations rows once and group userIds per locationId so we
  // can attach an assigned-staff list to each location without N+1 queries.
  private async staffByLocation(): Promise<Map<number, number[]>> {
    const rows = check(
      await supabase.from("staff_locations").select("user_id, location_id"),
      "staffByLocation",
    );
    const map = new Map<number, number[]>();
    for (const r of rows ?? []) {
      const list = map.get(r.location_id) ?? [];
      list.push(r.user_id);
      map.set(r.location_id, list);
    }
    return map;
  }

  async getLocations(): Promise<LocationWithStaff[]> {
    const rows = check(
      await supabase
        .from("locations")
        .select("*")
        .order("created_at", { ascending: true }),
      "getLocations",
    );
    const staffMap = await this.staffByLocation();
    return (rows ?? []).map((row) => ({
      ...rowToLocation(row),
      staffIds: staffMap.get(row.id) ?? [],
    }));
  }

  async createLocation(input: InsertLocation): Promise<LocationWithStaff> {
    const { staffIds = [], ...rest } = input;
    const row = check(
      await supabase
        .from("locations")
        .insert({
          name: rest.name,
          address: rest.address ?? "",
          color: rest.color ?? "#378ADD",
          active: true,
          created_at: new Date().toISOString(),
        })
        .select("*")
        .single(),
      "createLocation",
    );
    await this.setStaffForLocation(row.id, staffIds);
    return { ...rowToLocation(row), staffIds: [...staffIds] };
  }

  async updateLocation(
    id: number,
    patch: UpdateLocationInput,
  ): Promise<LocationWithStaff | undefined> {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.address !== undefined) set.address = patch.address;
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.active !== undefined) set.active = patch.active;
    if (patch.geofenceRadius !== undefined)
      set.geofence_radius = patch.geofenceRadius;
    let row: any;
    if (Object.keys(set).length > 0) {
      const rows = check(
        await supabase.from("locations").update(set).eq("id", id).select("*"),
        "updateLocation",
      );
      row = (rows ?? [])[0];
      if (!row) return undefined;
    } else {
      const rows = check(
        await supabase.from("locations").select("*").eq("id", id).limit(1),
        "updateLocation/fetch",
      );
      row = (rows ?? [])[0];
      if (!row) return undefined;
    }
    if (patch.staffIds !== undefined) {
      await this.setStaffForLocation(id, patch.staffIds);
    }
    const staffMap = await this.staffByLocation();
    return { ...rowToLocation(row), staffIds: staffMap.get(id) ?? [] };
  }

  // ---- Staff <-> location assignments ----
  async getLocationIdsForUser(userId: number): Promise<number[]> {
    const rows = check(
      await supabase
        .from("staff_locations")
        .select("location_id")
        .eq("user_id", userId),
      "getLocationIdsForUser",
    );
    return (rows ?? []).map((r) => r.location_id);
  }

  // Replace the full set of staff assigned to a location (delete-then-insert;
  // there is no unique constraint, so we clear the location's rows first).
  async setStaffForLocation(
    locationId: number,
    staffIds: number[],
  ): Promise<void> {
    check(
      await supabase
        .from("staff_locations")
        .delete()
        .eq("location_id", locationId)
        .select("id"),
      "setStaffForLocation/delete",
    );
    const unique = Array.from(new Set(staffIds)).filter((n) =>
      Number.isInteger(n),
    );
    if (unique.length === 0) return;
    check(
      await supabase
        .from("staff_locations")
        .insert(unique.map((uid) => ({ user_id: uid, location_id: locationId })))
        .select("id"),
      "setStaffForLocation/insert",
    );
  }

  // Persist the geocoded geofence center for a location (filled lazily the
  // first time a shift check-in needs it, then reused).
  async setLocationGeofenceCenter(
    id: number,
    latitude: number,
    longitude: number,
  ): Promise<Location | undefined> {
    const rows = check(
      await supabase
        .from("locations")
        .update({ latitude, longitude })
        .eq("id", id)
        .select("*"),
      "setLocationGeofenceCenter",
    );
    const row = (rows ?? [])[0];
    return row ? rowToLocation(row) : undefined;
  }

  // ---- Shifts ----
  // The single open shift for a user (checkOutAt is null), if any. There is at
  // most one because check-in refuses to open a second while one is open.
  async getActiveShiftForUser(userId: number): Promise<Shift | undefined> {
    const rows = check(
      await supabase
        .from("shifts")
        .select("*")
        .eq("user_id", userId)
        .is("check_out_at", null)
        .order("check_in_at", { ascending: false })
        .limit(1),
      "getActiveShiftForUser",
    );
    const row = (rows ?? [])[0];
    return row ? rowToShift(row) : undefined;
  }

  async getShiftById(id: number): Promise<Shift | undefined> {
    const rows = check(
      await supabase.from("shifts").select("*").eq("id", id).limit(1),
      "getShiftById",
    );
    const row = (rows ?? [])[0];
    return row ? rowToShift(row) : undefined;
  }

  async getShiftsForUser(userId: number, limit = 60): Promise<Shift[]> {
    const rows = check(
      await supabase
        .from("shifts")
        .select("*")
        .eq("user_id", userId)
        .order("check_in_at", { ascending: false })
        .limit(limit),
      "getShiftsForUser",
    );
    return (rows ?? []).map(rowToShift);
  }

  // ---- Cash collections ----
  async addCashCollection(
    row: InsertCashCollection,
  ): Promise<CashCollection> {
    const inserted = check(
      await supabase
        .from("cash_collections")
        .insert({
          day: row.day,
          snapshot_session_id: row.snapshotSessionId ?? null,
          license_plate: row.licensePlate,
          make_model: row.makeModel ?? "",
          amount: row.amount ?? 0,
          collected_by_id: row.collectedById,
          collected_by_name: row.collectedByName ?? "",
          collected_at: row.collectedAt,
          reconciled: row.reconciled ?? false,
          reconciled_at: row.reconciledAt ?? null,
          reconciled_by_name: row.reconciledByName ?? null,
        })
        .select("*")
        .single(),
      "addCashCollection",
    );
    return rowToCashCollection(inserted);
  }

  async getAllCashCollections(): Promise<CashCollection[]> {
    // Exclude voided (soft-deleted) rows so they drop out of every total,
    // holder tracker, and recent list. The rows remain in the table as an
    // audit trail. `.neq("voided", true)` also matches NULL voided values for
    // legacy rows written before the column existed.
    const rows = check(
      await supabase
        .from("cash_collections")
        .select("*")
        .neq("voided", true)
        .order("collected_at", { ascending: false }),
      "getAllCashCollections",
    );
    return (rows ?? []).map(rowToCashCollection);
  }

  // Void (soft delete) a single cash entry. Admin-only at the route layer.
  // Idempotent: only flips rows that aren't already voided, and stamps who
  // voided it + when for the audit trail. Returns the updated row, or null if
  // it was already voided / not found.
  async voidCashCollection(
    id: number,
    voidedByName: string,
  ): Promise<CashCollection | null> {
    const rows = check(
      await supabase
        .from("cash_collections")
        .update({
          voided: true,
          voided_at: new Date().toISOString(),
          voided_by_name: voidedByName,
        })
        .eq("id", id)
        .neq("voided", true)
        .select("*"),
      "voidCashCollection",
    );
    const row = (rows ?? [])[0];
    return row ? rowToCashCollection(row) : null;
  }

  async reconcileCashCollections(
    ids: number[],
    reconciledByName: string,
  ): Promise<CashCollection[]> {
    if (!ids || ids.length === 0) return [];
    // Only flip entries that are still unreconciled (idempotent + avoids
    // overwriting an earlier approver's stamp if two admins act at once).
    const rows = check(
      await supabase
        .from("cash_collections")
        .update({
          reconciled: true,
          reconciled_at: new Date().toISOString(),
          reconciled_by_name: reconciledByName,
        })
        .in("id", ids)
        .eq("reconciled", false)
        .select("*"),
      "reconcileCashCollections",
    );
    return (rows ?? []).map(rowToCashCollection);
  }

  async getCashForCollector(
    collectorId: number,
  ): Promise<CashCollection[]> {
    const rows = check(
      await supabase
        .from("cash_collections")
        .select("*")
        .eq("collected_by_id", collectorId)
        .neq("voided", true)
        .order("collected_at", { ascending: false }),
      "getCashForCollector",
    );
    return (rows ?? []).map(rowToCashCollection);
  }

  async getCashSummaryForCollector(
    collectorId: number,
  ): Promise<CashSummary> {
    const all = await this.getCashForCollector(collectorId);
    let owedTotal = 0;
    let reconciledTotal = 0;
    let owedCount = 0;
    for (const c of all) {
      const amt = Number(c.amount) || 0;
      if (c.reconciled) {
        reconciledTotal += amt;
      } else {
        owedTotal += amt;
        owedCount += 1;
      }
    }
    // The attendant's cash tracker must show EVERY unverified (owed) entry so
    // they can reconcile the full count with admin — never truncate these.
    // We return all unreconciled entries (newest first) plus a small tail of
    // the most recent reconciled ones for context. The list naturally resets
    // as admin verifies entries (they drop out of the unreconciled set).
    const unreconciled = all.filter((c) => !c.reconciled);
    const reconciled = all.filter((c) => c.reconciled);
    const reconciledTail = reconciled.slice(0, 10);
    // Find the most recent reconciliation stamp so the attendant can be shown a
    // "Cash verified by <admin>" confirmation when their count is reset.
    let lastReconciledAt: string | null = null;
    let lastReconciledByName: string | null = null;
    for (const c of reconciled) {
      const at = c.reconciledAt || null;
      if (at && (!lastReconciledAt || at > lastReconciledAt)) {
        lastReconciledAt = at;
        lastReconciledByName = c.reconciledByName || null;
      }
    }
    return {
      owedTotal: Math.round(owedTotal * 100) / 100,
      reconciledTotal: Math.round(reconciledTotal * 100) / 100,
      owedCount,
      recent: [...unreconciled, ...reconciledTail],
      lastReconciledAt,
      lastReconciledByName,
    };
  }

  async createShift(input: {
    userId: number;
    userName: string;
    locationId: number;
    locationName: string;
    checkInLat: number;
    checkInLng: number;
    geofenceVerified: boolean;
  }): Promise<Shift> {
    const row = check(
      await supabase
        .from("shifts")
        .insert({
          user_id: input.userId,
          user_name: input.userName,
          location_id: input.locationId,
          location_name: input.locationName,
          check_in_at: new Date().toISOString(),
          check_out_at: null,
          check_in_lat: input.checkInLat,
          check_in_lng: input.checkInLng,
          geofence_verified: input.geofenceVerified,
        })
        .select("*")
        .single(),
      "createShift",
    );
    return rowToShift(row);
  }

  async closeShift(
    id: number,
    checkOutLat: number | null,
    checkOutLng: number | null,
  ): Promise<Shift | undefined> {
    const rows = check(
      await supabase
        .from("shifts")
        .update({
          check_out_at: new Date().toISOString(),
          check_out_lat: checkOutLat,
          check_out_lng: checkOutLng,
        })
        .eq("id", id)
        .is("check_out_at", null)
        .select("*"),
      "closeShift",
    );
    const row = (rows ?? [])[0];
    return row ? rowToShift(row) : undefined;
  }

  // ---- Paid-car snapshots ----
  async getSnapshotsForDay(day: string): Promise<PaidSnapshot[]> {
    const rows = check(
      await supabase
        .from("paid_snapshots")
        .select("*")
        .eq("day", day)
        .order("paid_at", { ascending: false }),
      "getSnapshotsForDay",
    );
    return (rows ?? []).map(rowToSnapshot);
  }

  async getManualSnapshotsForDay(day: string): Promise<PaidSnapshot[]> {
    const rows = check(
      await supabase
        .from("paid_snapshots")
        .select("*")
        .eq("day", day)
        .eq("source", "manual")
        .order("paid_at", { ascending: false }),
      "getManualSnapshotsForDay",
    );
    return (rows ?? []).map(rowToSnapshot);
  }

  async hasSnapshotForDay(day: string): Promise<boolean> {
    const res = await supabase
      .from("paid_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("day", day);
    if (res.error) {
      throw new Error(`[storage] hasSnapshotForDay: ${res.error.message}`);
    }
    return (res.count ?? 0) > 0;
  }

  // Atomically replace a day's STRIPE rows with a fresh set. Manual rows for
  // the day are left untouched so attendant-entered cars survive refreshes.
  // (No multi-statement transaction over REST; delete-then-insert is fine here
  // because only one day's Stripe rows are touched and the data is re-derivable
  // from Stripe.)
  async replaceSnapshotsForDay(
    day: string,
    rows: InsertPaidSnapshot[],
  ): Promise<void> {
    check(
      await supabase
        .from("paid_snapshots")
        .delete()
        .eq("day", day)
        .eq("source", "stripe")
        .select("id"),
      "replaceSnapshotsForDay/delete",
    );
    if (rows.length === 0) return;
    check(
      await supabase
        .from("paid_snapshots")
        .insert(
          rows.map((r) => ({
            day: r.day,
            session_id: r.sessionId,
            license_plate: r.licensePlate,
            normalized_plate: r.normalizedPlate,
            make_model: r.makeModel,
            color: r.color,
            paid_at: r.paidAt,
            source: r.source ?? "stripe",
          })),
        )
        .select("id"),
      "replaceSnapshotsForDay/insert",
    );
  }

  async addManualSnapshot(row: InsertPaidSnapshot): Promise<PaidSnapshot> {
    const inserted = check(
      await supabase
        .from("paid_snapshots")
        .insert({
          day: row.day,
          session_id: row.sessionId,
          license_plate: row.licensePlate,
          normalized_plate: row.normalizedPlate,
          make_model: row.makeModel,
          color: row.color,
          paid_at: row.paidAt,
          source: "manual",
          amount: row.amount ?? null,
          method: row.method ?? null,
          space: row.space ?? null,
        })
        .select("*")
        .single(),
      "addManualSnapshot",
    );
    return rowToSnapshot(inserted);
  }

  // Delete a MANUAL paid-car entry by its session id. The `source = manual`
  // filter is a hard guard so Stripe rows can never be removed through this
  // path — only attendant/admin-entered manual rows are deletable.
  async deleteManualSnapshot(
    sessionId: string,
  ): Promise<{ changes: number }> {
    const rows = check(
      await supabase
        .from("paid_snapshots")
        .delete()
        .eq("session_id", sessionId)
        .eq("source", "manual")
        .select("id"),
      "deleteManualSnapshot",
    );
    return { changes: (rows ?? []).length };
  }

  async getAllSnapshots(): Promise<PaidSnapshot[]> {
    const rows = check(
      await supabase.from("paid_snapshots").select("*"),
      "getAllSnapshots",
    );
    return (rows ?? []).map(rowToSnapshot);
  }

  // Rolling 30-day retention: drop boots before cutoffIso and snapshots
  // for days before cutoffDay.
  async pruneOlderThan(cutoffDay: string, cutoffIso: string): Promise<void> {
    check(
      await supabase
        .from("boots")
        .delete()
        .lt("booted_at", cutoffIso)
        .select("id"),
      "pruneOlderThan/boots",
    );
    check(
      await supabase
        .from("paid_snapshots")
        .delete()
        .lt("day", cutoffDay)
        .select("id"),
      "pruneOlderThan/snapshots",
    );
  }

  // ---- Settings ----
  private async getSettingValue(key: string): Promise<string | undefined> {
    const rows = check(
      await supabase.from("settings").select("*").eq("key", key).limit(1),
      "getSettingValue",
    );
    const row = (rows ?? [])[0];
    return row?.value;
  }

  private async setSettingValue(key: string, value: string): Promise<void> {
    // Upsert on the primary key.
    check(
      await supabase
        .from("settings")
        .upsert({ key, value }, { onConflict: "key" })
        .select("key"),
      "setSettingValue",
    );
  }

  private clampHistoryDays(n: number): number {
    if (!Number.isFinite(n)) return HISTORY_VISIBLE_DAYS_DEFAULT;
    const i = Math.round(n);
    return Math.min(
      HISTORY_VISIBLE_DAYS_MAX,
      Math.max(HISTORY_VISIBLE_DAYS_MIN, i),
    );
  }

  async getSettings(): Promise<AppSettings> {
    const raw = await this.getSettingValue("historyVisibleDays");
    const parsed =
      raw === undefined ? HISTORY_VISIBLE_DAYS_DEFAULT : Number(raw);
    const finRaw = await this.getSettingValue("showFinancialsToStaff");
    const showFinancialsToStaff =
      finRaw === undefined
        ? SHOW_FINANCIALS_TO_STAFF_DEFAULT
        : finRaw === "true";
    return {
      historyVisibleDays: this.clampHistoryDays(parsed),
      showFinancialsToStaff,
    };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (patch.historyVisibleDays !== undefined) {
      const clamped = this.clampHistoryDays(patch.historyVisibleDays);
      await this.setSettingValue("historyVisibleDays", String(clamped));
    }
    if (patch.showFinancialsToStaff !== undefined) {
      await this.setSettingValue(
        "showFinancialsToStaff",
        patch.showFinancialsToStaff ? "true" : "false",
      );
    }
    return this.getSettings();
  }
}

export const storage = new DatabaseStorage();

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
// Seed a default admin + the two pre-created staff accounts on first run so the
// owner can log in immediately. Each seeded account is forced to set its own
// password on first login (mustChangePassword), so the well-known seed
// passwords below are only ever valid for the very first sign-in.
// ---------------------------------------------------------------------------
export const DEFAULT_ADMIN = {
  username: "admin",
  name: "Admin",
  password: "admin123",
  role: "admin" as const,
};

// Pre-created staff (provided by the owner). Forced to change password on first
// login.
const SEED_STAFF: Array<{
  username: string;
  name: string;
  password: string;
  role: Role;
}> = [
  { username: "chop1", name: "Chop", password: "chop123", role: "enforcer" },
  { username: "mari1", name: "Mari", password: "mari123", role: "attendant" },
];

const SEED_ADMIN_MUST_CHANGE = true;

// Seed default settings on first run so GET /api/settings is well-defined.
export async function seedDefaultSettings(): Promise<void> {
  try {
    const rows = check(
      await supabase
        .from("settings")
        .select("key")
        .eq("key", "historyVisibleDays")
        .limit(1),
      "seedDefaultSettings/check",
    );
    if (!(rows ?? [])[0]) {
      check(
        await supabase
          .from("settings")
          .insert({
            key: "historyVisibleDays",
            value: String(HISTORY_VISIBLE_DAYS_DEFAULT),
          })
          .select("key"),
        "seedDefaultSettings/insert",
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[seed] Failed to seed default settings", err);
  }
}

// Seed the default admin and pre-created staff. Idempotent: each account is
// only created if its username doesn't already exist (case-insensitive).
export async function seedDefaultAdmin(): Promise<void> {
  try {
    const toSeed = [
      {
        username: DEFAULT_ADMIN.username,
        name: DEFAULT_ADMIN.name,
        password: DEFAULT_ADMIN.password,
        role: DEFAULT_ADMIN.role as Role,
        mustChange: SEED_ADMIN_MUST_CHANGE,
      },
      ...SEED_STAFF.map((s) => ({ ...s, mustChange: true })),
    ];

    for (const acct of toSeed) {
      const existing = check(
        await supabase
          .from("users")
          .select("id")
          .ilike("username", acct.username)
          .limit(1),
        "seedDefaultAdmin/check",
      );
      if ((existing ?? [])[0]) continue;
      check(
        await supabase
          .from("users")
          .insert({
            username: acct.username,
            name: acct.name,
            password_hash: hashPassword(acct.password),
            role: acct.role,
            active: true,
            must_change_password: acct.mustChange,
            created_at: new Date().toISOString(),
          })
          .select("id"),
        "seedDefaultAdmin/insert",
      );
      // eslint-disable-next-line no-console
      console.log(`[seed] Created account "${acct.username}" (${acct.role})`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[seed] Failed to seed accounts", err);
  }
}
