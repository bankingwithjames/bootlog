import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Users & roles
// ---------------------------------------------------------------------------
// Three roles, each with a distinct permission set (enforced on the server
// and reflected in the UI):
//   admin     -> full access: manage users, place/edit/delete boots, full
//                enforcement workflow, add/edit/remove paid cars, settings.
//   enforcer  -> add/edit boots, full enforcement workflow (complete/settle/
//                release/re-open), work the boot-request queue. No user mgmt,
//                no deleting boots.
//   attendant -> add/edit paid cars (amount/details), submit boot REQUESTS for
//                an enforcer to act on. Cannot delete paid cars, cannot delete
//                boots, cannot run the enforcement workflow.
// Max number of evidence photos allowed per boot / boot request.
export const MAX_BOOT_PHOTOS = 5;

export const ROLES = ["admin", "enforcer", "attendant"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  enforcer: "Enforcer",
  attendant: "Attendant",
};

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Login handle (case-insensitive unique enforced in app code).
  username: text("username").notNull(),
  // Display name shown in the UI and audit trail.
  name: text("name").notNull(),
  // scrypt hash, stored as "<saltHex>:<hashHex>".
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("attendant"),
  // Soft-disable: inactive users cannot log in but are retained for audit.
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  // When true, the user must set a new password before using the app. Used to
  // force the seeded default admin (and admin-reset accounts) off the known
  // default password on first login.
  mustChangePassword: integer("must_change_password", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: text("created_at").notNull(),
});

// Public-facing user shape (never expose passwordHash to the client).
export type User = Omit<typeof users.$inferSelect, "passwordHash">;

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  // When true, the session is kept alive for an extended window (48h).
  // Optional so older clients still work; defaults to false (shorter session).
  rememberMe: z.boolean().optional().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

// Admin creates a user.
export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters")
    .regex(/^[a-zA-Z0-9_.-]+$/, "Letters, numbers, . _ - only"),
  name: z.string().trim().min(1, "Name is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.enum(ROLES),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

// Admin edits a user (all fields optional; password only if changing it).
export const updateUserSchema = z.object({
  name: z.string().trim().min(1).optional(),
  password: z.string().min(6, "Password must be at least 6 characters").optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// A signed-in user changes their own password (used for the forced first-login
// change and for voluntary changes).
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(6, "New password must be at least 6 characters"),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ---------------------------------------------------------------------------
// Parking locations (multi-location support)
// ---------------------------------------------------------------------------
// A parking lot / garage the business enforces. Boots can be tagged to a
// location, staff are assigned to one or more locations (functional access
// control), and admins manage the location list. Each location carries a
// color used as a visual key across the per-location overview and history.
export const LOCATION_COLORS = [
  "#378ADD", // blue
  "#1D9E75", // green
  "#7F77DD", // purple
  "#E8560A", // brand orange
  "#D9890F", // amber
  "#C0392B", // red
  "#0E7C7B", // teal
  "#8E44AD", // violet
] as const;

export const locations = sqliteTable("locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // Optional street address shown in management + overview cards.
  address: text("address").notNull().default(""),
  // Hex color used as the location's visual key (dot/top-border).
  color: text("color").notNull().default("#378ADD"),
  // Soft-disable: inactive locations are retained but not offered for new
  // boots and shown as Inactive in management.
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  // Geofence center, auto-detected by geocoding `address` server-side the first
  // time it's needed. Null until geocoded (or if geocoding fails). The shift
  // check-in flow uses these + geofenceRadius to verify the attendant is on-lot.
  latitude: real("latitude"),
  longitude: real("longitude"),
  // Geofence radius in meters. Admin-tunable; defaults to 150m, a reasonable
  // bound for a parking lot plus GPS jitter.
  geofenceRadius: real("geofence_radius").notNull().default(150),
  createdAt: text("created_at").notNull(),
});

export type Location = typeof locations.$inferSelect;

// Staff <-> location assignment (functional access control). A row means the
// user may see/place boots at that location. Admins implicitly see all.
export const staffLocations = sqliteTable("staff_locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  locationId: integer("location_id").notNull(),
});

export type StaffLocation = typeof staffLocations.$inferSelect;

// Admin creates/edits a location. Color is optional (server picks a default
// from LOCATION_COLORS when omitted). staffIds assigns staff in one call.
export const insertLocationSchema = z.object({
  name: z.string().trim().min(1, "Location name is required").max(80),
  address: z.string().trim().max(160).optional().default(""),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a hex value")
    .optional(),
  staffIds: z.array(z.coerce.number().int()).optional().default([]),
});
export type InsertLocation = z.infer<typeof insertLocationSchema>;

export const updateLocationSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  address: z.string().trim().max(160).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a hex value")
    .optional(),
  active: z.boolean().optional(),
  // Admin can tune the geofence radius (meters). Bounded to a sane range.
  geofenceRadius: z.coerce.number().min(25).max(2000).optional(),
  // When provided, replaces the location's full staff-assignment set.
  staffIds: z.array(z.coerce.number().int()).optional(),
});
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

// Location enriched with its assigned staff ids (returned by the API).
export type LocationWithStaff = Location & { staffIds: number[] };

// ---------------------------------------------------------------------------
// Boot requests (attendant -> enforcer queue)
// ---------------------------------------------------------------------------
// An attendant flags a vehicle for booting. It lands in a pending queue an
// enforcer/admin works from: "initiate" converts it into an active boot,
// "dismiss" closes it without action.
export const BOOT_REQUEST_STATUSES = ["pending", "initiated", "dismissed"] as const;
export type BootRequestStatus = (typeof BOOT_REQUEST_STATUSES)[number];

export const bootRequests = sqliteTable("boot_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  licensePlate: text("license_plate").notNull(),
  makeModel: text("make_model").notNull(),
  // Optional vehicle color so the enforcer can identify the car quickly.
  color: text("color"),
  // Optional suggested fee + free-text note from the attendant.
  suggestedFee: real("suggested_fee").notNull().default(0),
  note: text("note").notNull().default(""),
  // Evidence photos (same JSON-array-of-data-URLs convention as boots).
  photos: text("photos").notNull().default("[]"),
  status: text("status").notNull().default("pending"),
  // Who requested it (attendant) and when.
  requestedById: integer("requested_by_id"),
  requestedByName: text("requested_by_name").notNull().default(""),
  requestedAt: text("requested_at").notNull(),
  // Who resolved it (enforcer/admin), the resulting boot id (if initiated),
  // and when it was resolved.
  resolvedById: integer("resolved_by_id"),
  resolvedByName: text("resolved_by_name"),
  resolvedAt: text("resolved_at"),
  bootId: integer("boot_id"),
});

export const insertBootRequestSchema = z.object({
  licensePlate: z.string().trim().min(1, "License plate is required"),
  makeModel: z.string().trim().min(1, "Make & model is required"),
  color: z.string().trim().max(40).optional().nullable(),
  suggestedFee: z.coerce.number().min(0).optional().default(0),
  note: z.string().trim().max(500).optional().default(""),
  photos: z
    .array(z.string())
    .max(MAX_BOOT_PHOTOS, `At most ${MAX_BOOT_PHOTOS} photos are allowed`)
    .optional()
    .default([]),
});
export type InsertBootRequest = z.infer<typeof insertBootRequestSchema>;
export type BootRequest = Omit<typeof bootRequests.$inferSelect, "photos"> & {
  photos: string[];
};

// Enforcer/admin resolves a request.
export const resolveBootRequestSchema = z.object({
  action: z.enum(["initiate", "dismiss"]),
  // When initiating, the enforcer can override the fee that gets placed.
  bootFee: z.coerce.number().min(0).optional(),
});
export type ResolveBootRequestInput = z.infer<typeof resolveBootRequestSchema>;

// Enforcement lifecycle for a booted car:
//   booted    -> car is on boot, awaiting resolution (active enforcement)
//   released  -> boot removed for NO fee (courtesy / warning, $0 collected)
//   settled   -> partial payment accepted (settled for less than the boot fee)
//   completed -> full boot fee collected (case closed, paid in full)
export const BOOT_STATUSES = [
  "booted",
  "released",
  "settled",
  "completed",
] as const;
export type BootStatus = (typeof BOOT_STATUSES)[number];

// A booted car record entered by the attendant. It carries an enforcement
// workflow: an owed boot fee, the amount actually collected, a lifecycle
// status, and the time it was resolved.
export const boots = sqliteTable("boots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  licensePlate: text("license_plate").notNull(),
  makeModel: text("make_model").notNull(),
  // Optional vehicle color for quicker visual identification in the field.
  color: text("color"),
  // ISO 8601 string for the date & time the car was booted.
  bootedAt: text("booted_at").notNull(),
  // The boot fee owed by the violator (set when the boot is placed).
  bootFee: real("boot_fee").notNull().default(0),
  // Amount actually collected so far (0 until released/settled/completed).
  amountCollected: real("amount_collected").notNull().default(0),
  // Enforcement lifecycle status.
  status: text("status").notNull().default("booted"),
  // ISO 8601 timestamp the boot was resolved (released/settled/completed).
  resolvedAt: text("resolved_at"),
  // Optional GPS coordinates captured at the time the boot was placed, used as
  // location evidence for disputes. Null when the device denies/lacks location.
  latitude: real("latitude"),
  longitude: real("longitude"),
  // Up to 5 evidence photos, stored as a JSON array of base64 data URLs.
  // SQLite has no array type, so this is a JSON text column parsed in app code.
  photos: text("photos").notNull().default("[]"),
  // Audit: who placed this boot (id + display name snapshot).
  createdById: integer("created_by_id"),
  createdByName: text("created_by_name").notNull().default(""),
  // Audit: who last changed its enforcement status (id + display name).
  lastActionById: integer("last_action_by_id"),
  lastActionByName: text("last_action_by_name"),
  // Legacy column kept for backward compatibility; no longer written.
  feePaid: real("fee_paid").notNull().default(0),
  // Parking location this boot belongs to (multi-location support). Nullable:
  // boots placed before locations existed (and "No location" picks) stay null
  // and are excluded from per-location enforcement overview counts.
  locationId: integer("location_id"),
  // ---- Enforcer Mobile Preview (additive, nullable; live code ignores it) ----
  // Optional richer-lifecycle hint. NULL = derive the stage from `status`.
  // Only the preview reads/writes this; the live 4-state `status` is unchanged.
  enforcementStage: text("enforcement_stage"),
  // Optional structured evidence labels captured in the field, stored as a JSON
  // array of { label, photoIndex }. Separate from `photos` so the live photo
  // array stays byte-for-byte untouched.
  evidenceLabels: text("evidence_labels").default("[]"),
});

export const insertBootSchema = createInsertSchema(boots)
  .omit({
    id: true,
    amountCollected: true,
    status: true,
    resolvedAt: true,
    latitude: true,
    longitude: true,
    photos: true,
    createdById: true,
    createdByName: true,
    lastActionById: true,
    lastActionByName: true,
    feePaid: true,
    enforcementStage: true,
    evidenceLabels: true,
  })
  .extend({
    // Photos arrive as an array of data-URL strings; capped at MAX_BOOT_PHOTOS.
    photos: z
      .array(z.string())
      .max(MAX_BOOT_PHOTOS, `At most ${MAX_BOOT_PHOTOS} photos are allowed`)
      .optional()
      .default([]),
    // Optional GPS coordinates captured client-side at placement time.
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    // Optional vehicle color; trimmed, empty string coerced to undefined.
    color: z
      .string()
      .trim()
      .max(40)
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
    // Optional parking location id; null means "No location".
    locationId: z.coerce.number().int().nullable().optional(),
  });

export type InsertBoot = z.infer<typeof insertBootSchema>;
// The DB row stores photos as a JSON string; the API returns a parsed array.
export type Boot = Omit<typeof boots.$inferSelect, "photos"> & {
  photos: string[];
  latitude: number | null;
  longitude: number | null;
  color: string | null;
  locationId: number | null;
  enforcementStage: string | null;
  evidenceLabels: string | null;
};

// Payload for resolving / updating a boot's enforcement status.
//   - completed: amountCollected defaults to the full boot fee
//   - settled:   amountCollected is the partial amount actually accepted
//   - released:  amountCollected is forced to 0
//   - booted:    re-open an active case (amountCollected reset to 0)
export const bootStatusSchema = z.object({
  status: z.enum(BOOT_STATUSES),
  // Amount collected for this resolution. Optional; server derives sensible
  // defaults per status when omitted.
  amountCollected: z.coerce.number().min(0).optional(),
});

export type BootStatusUpdate = z.infer<typeof bootStatusSchema>;

// ---- Release requests (Page 4) ----
// An attendant cannot remove a boot themselves; they REQUEST a release and an
// enforcer/admin performs the physical removal. Each request is queued here so
// enforcers have a visible work list (in addition to the stubbed SMS ping).
// Lifecycle: pending -> released (enforcer removed the boot) | dismissed.
export const RELEASE_REQUEST_STATUSES = [
  "pending",
  "released",
  "dismissed",
] as const;
export type ReleaseRequestStatus = (typeof RELEASE_REQUEST_STATUSES)[number];

export const releaseRequests = sqliteTable("release_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The booted vehicle this request targets.
  bootId: integer("boot_id").notNull(),
  licensePlate: text("license_plate").notNull(),
  makeModel: text("make_model").notNull(),
  // Optional free-text reason from the attendant (e.g. "owner paid in cash").
  note: text("note").notNull().default(""),
  status: text("status").notNull().default("pending"),
  // Who requested (attendant) and when.
  requestedById: integer("requested_by_id"),
  requestedByName: text("requested_by_name").notNull().default(""),
  requestedAt: text("requested_at").notNull(),
  // Who resolved (enforcer/admin) and when.
  resolvedById: integer("resolved_by_id"),
  resolvedByName: text("resolved_by_name"),
  resolvedAt: text("resolved_at"),
  // Lot the boot belongs to (for enforcer scoping / context).
  locationId: integer("location_id"),
});

// Attendant submits a release request for a specific boot.
export const insertReleaseRequestSchema = z.object({
  bootId: z.coerce.number().int().positive("A boot id is required"),
  note: z.string().trim().max(500).optional().default(""),
});
export type InsertReleaseRequest = z.infer<typeof insertReleaseRequestSchema>;
export type ReleaseRequest = typeof releaseRequests.$inferSelect;

// A stored snapshot of a paid car pulled from Stripe, keyed to a local day.
// Snapshots let the attendant browse history for any of the last 30 days
// without re-querying Stripe (and even if Stripe data later changes).
// Today's data is still read live; finalized past days are served from here.
export const paidSnapshots = sqliteTable("paid_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Local day this snapshot belongs to, YYYY-MM-DD (attendant's timezone).
  day: text("day").notNull(),
  // Stripe Checkout Session id, used to de-dupe within a day.
  sessionId: text("session_id").notNull(),
  licensePlate: text("license_plate").notNull(),
  // Normalized plate (uppercase, alphanumerics only) for cross-reference.
  normalizedPlate: text("normalized_plate").notNull(),
  makeModel: text("make_model").notNull(),
  color: text("color").notNull(),
  // ISO 8601 timestamp of when the payment was made.
  paidAt: text("paid_at").notNull(),
  // Where this row came from: "stripe" (pulled from Stripe) or "manual"
  // (entered by the attendant). Manual rows persist across Stripe refreshes.
  source: text("source").notNull().default("stripe"),
  // ---- Manual-entry payment details (nullable; Stripe rows leave these null) ----
  // Amount collected at the lot for a manually-logged vehicle. The dollar value
  // is the source of record for cash/card/app payments taken in the field;
  // Stripe remains the system of record for online payments.
  amount: real("amount"),
  // How the field payment was taken: "cash" | "card" | "app".
  method: text("method"),
  // Optional parking space / row label (e.g. "Row C \u00b7 #18").
  space: text("space"),
});

export const insertPaidSnapshotSchema = createInsertSchema(paidSnapshots).omit({
  id: true,
});

export type InsertPaidSnapshot = z.infer<typeof insertPaidSnapshotSchema>;
export type PaidSnapshot = typeof paidSnapshots.$inferSelect;

// Payload for a manually-entered paid car. The server fills in day/source/
// paidAt/sessionId/normalizedPlate.
export const manualPaidCarSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  tz: z.number().int().optional().default(0),
  licensePlate: z.string().trim().min(1, "License plate is required"),
  makeModel: z.string().trim().min(1, "Make & model is required"),
  color: z.string().trim().min(1, "Color is required"),
  // Optional parking space / row label.
  space: z.string().trim().max(60).optional(),
  // Amount collected at the lot (dollars). Optional; >= 0 when present.
  amount: z.number().nonnegative().optional(),
  // Payment method taken in the field.
  method: z.enum(["cash", "card", "app"]).optional(),
});

export type ManualPaidCar = z.infer<typeof manualPaidCarSchema>;

// ---------------------------------------------------------------------------
// Cash collections (attendant cash ledger for admin reconciliation)
// ---------------------------------------------------------------------------
// Every manual CASH payment an attendant records is also written here as an
// auditable ledger row, separate from the operational paid_snapshots record.
// paid_snapshots stays the inventory record; cash_collections is the money
// trail the admin uses to verify, then physically collect, the cash an
// attendant is holding. Each row is attributed to the collecting attendant
// (collectedById/Name) and carries a reconciliation flag the admin flips once
// the cash has been handed over (admin-side view is built later).
export const cashCollections = sqliteTable("cash_collections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Local day this collection belongs to, YYYY-MM-DD (attendant's timezone).
  day: text("day").notNull(),
  // Links back to the paid_snapshots row this cash came from (sessionId).
  snapshotSessionId: text("snapshot_session_id"),
  licensePlate: text("license_plate").notNull(),
  makeModel: text("make_model").notNull().default(""),
  // Dollar amount of cash taken.
  amount: real("amount").notNull().default(0),
  // Attendant who collected the cash (id + name snapshot for the audit trail).
  collectedById: integer("collected_by_id").notNull(),
  collectedByName: text("collected_by_name").notNull().default(""),
  // ISO 8601 timestamp of when the cash was logged.
  collectedAt: text("collected_at").notNull(),
  // Reconciliation: false until the admin verifies + collects the cash.
  reconciled: integer("reconciled", { mode: "boolean" })
    .notNull()
    .default(false),
  reconciledAt: text("reconciled_at"),
  reconciledByName: text("reconciled_by_name"),
});

export type CashCollection = typeof cashCollections.$inferSelect;
export type InsertCashCollection = Omit<CashCollection, "id">;

// Running cash summary the attendant sees in their dashboard / cash tracker.
export type CashSummary = {
  // Total dollars of cash logged that the attendant still owes (unreconciled).
  owedTotal: number;
  // Total dollars reconciled (already handed to admin).
  reconciledTotal: number;
  // Count of unreconciled cash entries.
  owedCount: number;
  // Most recent cash entries (newest first), for the running list.
  recent: CashCollection[];
};

// ---------------------------------------------------------------------------
// App settings (admin-controlled key/value store)
// ---------------------------------------------------------------------------
// A tiny key/value store for admin-controlled app settings. The first setting
// is `historyVisibleDays`: how many days BACK (within the 30-day retention
// window) that STAFF (enforcer + attendant) may view in the Daily View date
// picker and the History log. Admin always bypasses this and sees all 30 days.
//   value = 1  -> staff see today + the previous day (the default).
//   value = 30 -> staff see the full retention window.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Setting = typeof settings.$inferSelect;

// Bounds for the history-visibility window (days BACK from today).
export const HISTORY_VISIBLE_DAYS_MIN = 1;
export const HISTORY_VISIBLE_DAYS_MAX = 30;
export const HISTORY_VISIBLE_DAYS_DEFAULT = 1;

// Default for the financial-visibility privacy toggle. When false (default),
// staff (enforcer + attendant) do NOT see the financial summary cards
// (Cars booted count, Collected total, Paid via Stripe count). Admin always
// sees them. An admin can flip this on to reveal those cards to staff.
export const SHOW_FINANCIALS_TO_STAFF_DEFAULT = false;

// Public shape of the settings the client cares about.
export type AppSettings = {
  historyVisibleDays: number;
  // When true, staff may see the financial summary cards on the dashboard.
  showFinancialsToStaff: boolean;
};

// Payload the admin sends to update settings (all fields optional).
export const updateSettingsSchema = z.object({
  historyVisibleDays: z.coerce
    .number()
    .int("Must be a whole number")
    .min(HISTORY_VISIBLE_DAYS_MIN, `Must be at least ${HISTORY_VISIBLE_DAYS_MIN}`)
    .max(HISTORY_VISIBLE_DAYS_MAX, `Must be at most ${HISTORY_VISIBLE_DAYS_MAX}`)
    .optional(),
  showFinancialsToStaff: z.coerce.boolean().optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// ---------------------------------------------------------------------------
// Shifts (attendant geofenced check-in / check-out)
// ---------------------------------------------------------------------------
// A work shift an attendant opens by checking in while physically inside their
// assigned lot's geofence, and closes by checking out. Check-in is HARD-BLOCKED
// server-side: the captured GPS point must fall within the location's geofence
// (center lat/lng + radius). An open shift has checkOutAt == null. Check-in and
// check-out each fire an SMS notification to the enforcer/admin (stubbed until
// the real provider is wired). At most one open shift per user at a time.
export const shifts = sqliteTable("shifts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Who is on shift (id + display-name snapshot for the audit trail).
  userId: integer("user_id").notNull(),
  userName: text("user_name").notNull().default(""),
  // The lot this shift is tied to.
  locationId: integer("location_id").notNull(),
  locationName: text("location_name").notNull().default(""),
  // ISO 8601 timestamps. checkOutAt is null while the shift is open.
  checkInAt: text("check_in_at").notNull(),
  checkOutAt: text("check_out_at"),
  // GPS captured at check-in (verified inside the geofence) and at check-out.
  checkInLat: real("check_in_lat"),
  checkInLng: real("check_in_lng"),
  checkOutLat: real("check_out_lat"),
  checkOutLng: real("check_out_lng"),
  // True once the server confirmed the check-in point was inside the geofence.
  geofenceVerified: integer("geofence_verified", { mode: "boolean" })
    .notNull()
    .default(false),
});

export type Shift = typeof shifts.$inferSelect;

// Attendant checks in: client sends its current GPS reading. The server
// verifies the point is inside the assigned location's geofence before opening
// the shift, so locationId is taken from the user's assignment, not the body.
export const checkInShiftSchema = z.object({
  locationId: z.coerce.number().int(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // Optional client-reported accuracy (meters) for diagnostics/leniency.
  accuracy: z.number().min(0).optional(),
});
export type CheckInShiftInput = z.infer<typeof checkInShiftSchema>;

// Attendant checks out: GPS is captured for the audit trail but not gated.
export const checkOutShiftSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});
export type CheckOutShiftInput = z.infer<typeof checkOutShiftSchema>;

// =============================================================================
// Enforcer Mobile Preview (preview-only, additive)
// =============================================================================
// The preview expresses a richer field-enforcement lifecycle than the live
// 4-state `boots.status`. Most stages are DERIVED at read time from existing
// data (boots + boot_requests + release_requests + Stripe paid status); only a
// few "hint" stages are persisted in boots.enforcementStage. Live code never
// reads these, so the attendant/admin/enforcer experience is unchanged.

export const ENFORCEMENT_STAGES = [
  "draft", // a boot request exists, not yet acted on
  "review_needed", // flagged for review (paid-plate match / mismatch)
  "pending_enforcement", // request initiated, boot not yet placed
  "booted", // boot physically placed, active
  "payment_pending", // booted + enforcer marked awaiting payment
  "paid", // settled or completed
  "release_pending", // open release request
  "released", // boot removed for no fee
  "completed", // paid in full, closed
  "cancelled", // request dismissed
  "reopened", // a resolved case re-opened to active
] as const;
export type EnforcementStage = (typeof ENFORCEMENT_STAGES)[number];

// Human labels + the semantic color family each stage maps to (per the plan's
// color system). Consumed by the preview UI badges.
export const ENFORCEMENT_STAGE_META: Record<
  EnforcementStage,
  { label: string; tone: "neutral" | "review" | "active" | "paid" | "released" | "info" }
> = {
  draft: { label: "Draft", tone: "neutral" },
  review_needed: { label: "Review needed", tone: "review" },
  pending_enforcement: { label: "Pending enforcement", tone: "review" },
  booted: { label: "Booted", tone: "active" },
  payment_pending: { label: "Payment pending", tone: "review" },
  paid: { label: "Paid", tone: "paid" },
  release_pending: { label: "Release pending", tone: "review" },
  released: { label: "Released", tone: "released" },
  completed: { label: "Completed", tone: "paid" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  reopened: { label: "Reopened", tone: "active" },
};

// Structured evidence label captured against a photo in the field. Stored as a
// JSON array in boots.evidenceLabels.
export const evidenceLabelSchema = z.object({
  label: z.string().trim().min(1).max(60),
  photoIndex: z.coerce.number().int().min(0).max(MAX_BOOT_PHOTOS - 1).nullable().optional(),
});
export type EvidenceLabel = z.infer<typeof evidenceLabelSchema>;

// Append-only audit timeline for enforcement actions (enforcement_events).
export const enforcementEvents = sqliteTable("enforcement_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bootId: integer("boot_id"),
  requestId: integer("request_id"),
  stage: text("stage").notNull(),
  note: text("note"),
  actorId: integer("actor_id"),
  actorName: text("actor_name"),
  createdAt: text("created_at").notNull(),
});
export type EnforcementEvent = typeof enforcementEvents.$inferSelect;

// Payload the preview sends when an enforcer advances a case to a new stage.
export const enforcementActionSchema = z.object({
  // The stage being entered (drives both the persisted hint and the audit row).
  stage: z.enum(ENFORCEMENT_STAGES),
  note: z.string().trim().max(500).optional(),
  // Optional structured evidence labels to persist on the boot.
  evidenceLabels: z.array(evidenceLabelSchema).max(MAX_BOOT_PHOTOS).optional(),
  // Optional collected amount when the stage implies a payment (paid/completed).
  amountCollected: z.coerce.number().min(0).optional(),
});
export type EnforcementActionInput = z.infer<typeof enforcementActionSchema>;
