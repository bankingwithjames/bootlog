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
});

export const insertBootSchema = createInsertSchema(boots)
  .omit({
    id: true,
    amountCollected: true,
    status: true,
    resolvedAt: true,
    photos: true,
    createdById: true,
    createdByName: true,
    lastActionById: true,
    lastActionByName: true,
    feePaid: true,
  })
  .extend({
    // Photos arrive as an array of data-URL strings; capped at MAX_BOOT_PHOTOS.
    photos: z
      .array(z.string())
      .max(MAX_BOOT_PHOTOS, `At most ${MAX_BOOT_PHOTOS} photos are allowed`)
      .optional()
      .default([]),
  });

export type InsertBoot = z.infer<typeof insertBootSchema>;
// The DB row stores photos as a JSON string; the API returns a parsed array.
export type Boot = Omit<typeof boots.$inferSelect, "photos"> & {
  photos: string[];
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
});

export type ManualPaidCar = z.infer<typeof manualPaidCarSchema>;

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

// Public shape of the settings the client cares about.
export type AppSettings = {
  historyVisibleDays: number;
};

// Payload the admin sends to update settings (all fields optional).
export const updateSettingsSchema = z.object({
  historyVisibleDays: z.coerce
    .number()
    .int("Must be a whole number")
    .min(HISTORY_VISIBLE_DAYS_MIN, `Must be at least ${HISTORY_VISIBLE_DAYS_MIN}`)
    .max(HISTORY_VISIBLE_DAYS_MAX, `Must be at most ${HISTORY_VISIBLE_DAYS_MAX}`)
    .optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
