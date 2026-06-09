import { boots } from '@shared/schema';
import type { Boot, InsertBoot } from '@shared/schema';
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

// Ensure the boots table exists (lightweight migration for the template).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS boots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_plate TEXT NOT NULL,
    make_model TEXT NOT NULL,
    booted_at TEXT NOT NULL,
    fee_paid REAL NOT NULL DEFAULT 0
  );
`);

export const db = drizzle(sqlite);

export interface IStorage {
  getBoots(): Promise<Boot[]>;
  createBoot(boot: InsertBoot): Promise<Boot>;
  deleteBoot(id: number): Promise<{ changes: number }>;
}

export class DatabaseStorage implements IStorage {
  async getBoots(): Promise<Boot[]> {
    return db.select().from(boots).orderBy(desc(boots.bootedAt)).all();
  }

  async createBoot(insertBoot: InsertBoot): Promise<Boot> {
    return db.insert(boots).values(insertBoot).returning().get();
  }

  async deleteBoot(id: number): Promise<{ changes: number }> {
    return db.delete(boots).where(eq(boots.id, id)).run();
  }
}

export const storage = new DatabaseStorage();
