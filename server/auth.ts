import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Role, User } from "@shared/schema";
import { supabase } from "./supabase";

// ---------------------------------------------------------------------------
// Password hashing (Node built-in scrypt; no external deps)
// ---------------------------------------------------------------------------
// Stored format: "<saltHex>:<hashHex>".
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  // Constant-time compare; lengths must match first.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Session tokens (persisted in Supabase `sessions` table).
// ---------------------------------------------------------------------------
// Tokens are stored in Postgres so a logged-in session survives server
// restarts, sandbox sleep, and redeploys — the user stays logged in.
// ---------------------------------------------------------------------------
// Default session window when "Keep me signed in" is NOT checked.
const TOKEN_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours
// Extended session window when "Keep me signed in" IS checked (default 48h).
const REMEMBER_ME_TTL_MS = 1000 * 60 * 60 * 48; // 48 hours

export async function createToken(
  userId: number,
  rememberMe = false,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const ttl = rememberMe ? REMEMBER_ME_TTL_MS : TOKEN_TTL_MS;
  const expires = new Date(now.getTime() + ttl);
  const { error } = await supabase.from("sessions").insert({
    token,
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  });
  if (error) {
    throw new Error(`[auth] createToken: ${error.message}`);
  }
  return token;
}

export async function destroyToken(token: string | undefined): Promise<void> {
  if (!token) return;
  await supabase.from("sessions").delete().eq("token", token);
}

// Invalidate every session for a user (used when an admin deactivates them or
// changes their password/role).
export async function destroyUserSessions(userId: number): Promise<void> {
  await supabase.from("sessions").delete().eq("user_id", userId);
}

export async function userIdForToken(
  token: string | undefined,
): Promise<number | null> {
  if (!token) return null;
  const { data, error } = await supabase
    .from("sessions")
    .select("user_id, expires_at")
    .eq("token", token)
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const s = data[0] as { user_id: number; expires_at: string };
  // Expired: clean it up and treat as logged out.
  if (new Date(s.expires_at).getTime() < Date.now()) {
    await supabase.from("sessions").delete().eq("token", token);
    return null;
  }
  return s.user_id;
}

function tokenFromRequest(req: Request): string | undefined {
  const auth = req.header("authorization") || req.header("Authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  // Fallback header for environments that strip Authorization.
  const x = req.header("x-auth-token");
  return x || undefined;
}

// Augment Express Request with the resolved user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

// Resolver injected by routes.ts so auth.ts stays storage-agnostic.
type UserResolver = (id: number) => Promise<User | undefined>;
let resolveUser: UserResolver = async () => undefined;
export function setUserResolver(fn: UserResolver): void {
  resolveUser = fn;
}

// Attaches req.user when a valid token is present; never blocks.
export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const uid = await userIdForToken(tokenFromRequest(req));
    if (uid != null) {
      const user = await resolveUser(uid);
      if (user && user.active) req.user = user;
    }
  } catch {
    // Non-fatal: treat as unauthenticated if session lookup fails.
  }
  next();
}

// Requires a logged-in user.
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ message: "Sign in required" });
    return;
  }
  next();
}

// Requires the user to hold one of the given roles.
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: "Sign in required" });
      return;
    }
    if (!roles.includes(req.user.role as Role)) {
      res
        .status(403)
        .json({ message: "You don't have permission to do that" });
      return;
    }
    next();
  };
}
