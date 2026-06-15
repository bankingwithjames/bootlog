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

// Small helper: retry a Supabase query a few times on a TRANSIENT error
// (network blip, connection reset, rate-limit) before giving up. The published
// sandbox cold-start fires a burst of concurrent auth checks; without this a
// single transient failure would surface as a spurious 401 for a VALID token,
// bouncing the user back to the login screen on reload.
async function withRetry<T>(
  fn: () => Promise<{ data: T; error: any }>,
  attempts = 4,
): Promise<{ data: T; error: any }> {
  const backoff = [150, 400, 900, 1500];
  let last: { data: T; error: any } = { data: null as unknown as T, error: null };
  for (let i = 0; i < attempts; i++) {
    try {
      last = await fn();
      // No error -> success (this includes a legitimate empty result set).
      if (!last.error) return last;
    } catch (e) {
      last = { data: null as unknown as T, error: e };
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, backoff[i] ?? 1500));
    }
  }
  return last;
}

// Result of a token lookup. We MUST distinguish three cases so the auth
// middleware never logs a user out on a transient backend hiccup:
//   - { userId }            -> valid session
//   - { userId: null }      -> token genuinely not found / expired (real 401)
//   - { transientError }    -> backend unreachable; DO NOT treat as logged out
export type TokenLookup =
  | { userId: number; transientError?: false }
  | { userId: null; transientError: boolean };

export async function userIdForToken(
  token: string | undefined,
): Promise<TokenLookup> {
  if (!token) return { userId: null, transientError: false };
  const { data, error } = await withRetry(() =>
    supabase
      .from("sessions")
      .select("user_id, expires_at")
      .eq("token", token)
      .limit(1),
  );
  // After retries the backend is still erroring: transient, not a real 401.
  if (error) return { userId: null, transientError: true };
  const rows = (data ?? []) as { user_id: number; expires_at: string }[];
  if (rows.length === 0) return { userId: null, transientError: false };
  const s = rows[0];
  // Expired: clean it up and treat as a genuine logout.
  if (new Date(s.expires_at).getTime() < Date.now()) {
    await supabase.from("sessions").delete().eq("token", token).then(
      () => undefined,
      () => undefined,
    );
    return { userId: null, transientError: false };
  }
  return { userId: s.user_id };
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
      // Set when a token was present but the backend was transiently
      // unreachable while validating it. Lets requireAuth answer 503
      // (retryable) instead of 401 (which would log the user out).
      authTransientError?: boolean;
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
  const token = tokenFromRequest(req);
  if (!token) {
    next();
    return;
  }
  const lookup = await userIdForToken(token);
  if (lookup.userId != null) {
    try {
      const user = await resolveUser(lookup.userId);
      if (user && user.active) req.user = user;
    } catch {
      // The session was valid but the user lookup hit a transient backend
      // error. Don't log the user out over a hiccup — flag it as retryable.
      req.authTransientError = true;
    }
  } else if (lookup.transientError) {
    // Token present but backend unreachable -> retryable, not a real 401.
    req.authTransientError = true;
  }
  next();
}

// Paths that remain reachable while a user still owes a forced password change.
// Everything else is blocked server-side so the client-only gate can't be
// bypassed by calling the API directly with a valid token.
const PASSWORD_CHANGE_ALLOWLIST = new Set<string>([
  "/api/auth/me",
  "/api/auth/change-password",
  "/api/auth/logout",
]);

// Blocks authenticated users who must change their password from reaching any
// endpoint other than the allowlist above. Returns true if it handled (blocked)
// the request.
function blockedForPasswordChange(req: Request, res: Response): boolean {
  if (req.user && req.user.mustChangePassword) {
    // req.path excludes the query string; matches the mounted route path.
    if (!PASSWORD_CHANGE_ALLOWLIST.has(req.path)) {
      res.status(403).json({
        message: "Password change required",
        mustChangePassword: true,
      });
      return true;
    }
  }
  return false;
}

// Requires a logged-in user.
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    if (req.authTransientError) {
      // Backend was transiently unreachable while validating a present token.
      // Answer 503 so the client retries instead of logging out.
      res
        .status(503)
        .json({ message: "Service temporarily unavailable, retrying" });
      return;
    }
    res.status(401).json({ message: "Sign in required" });
    return;
  }
  if (blockedForPasswordChange(req, res)) return;
  next();
}

// Requires the user to hold one of the given roles.
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      if (req.authTransientError) {
        res
          .status(503)
          .json({ message: "Service temporarily unavailable, retrying" });
        return;
      }
      res.status(401).json({ message: "Sign in required" });
      return;
    }
    if (!roles.includes(req.user.role as Role)) {
      res
        .status(403)
        .json({ message: "You don't have permission to do that" });
      return;
    }
    if (blockedForPasswordChange(req, res)) return;
    next();
  };
}
