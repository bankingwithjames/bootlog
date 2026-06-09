import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// A booted car record entered by the attendant.
export const boots = sqliteTable("boots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  licensePlate: text("license_plate").notNull(),
  makeModel: text("make_model").notNull(),
  // ISO 8601 string for the date & time the car was booted.
  bootedAt: text("booted_at").notNull(),
  // Fee paid in dollars. 0 = unpaid.
  feePaid: real("fee_paid").notNull().default(0),
});

export const insertBootSchema = createInsertSchema(boots).omit({
  id: true,
});

export type InsertBoot = z.infer<typeof insertBootSchema>;
export type Boot = typeof boots.$inferSelect;
