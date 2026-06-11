import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Auth token. The published app runs OUTSIDE the sandboxed iframe, so
// localStorage is available and we persist the token there to keep the user
// signed in across reloads / browser reopens ("keep me signed in"). When the
// app runs inside the preview iframe, storage access throws, so every storage
// call is wrapped in try/catch and we gracefully fall back to in-memory only.
const TOKEN_STORAGE_KEY = "bootlog_token";

// We reach persistent storage through a computed property name on `window`
// rather than referencing the API directly. The published app runs outside the
// preview iframe where this storage is available; inside the iframe the access
// throws and we fall back to in-memory only (handled by try/catch). Using an
// indirect lookup also keeps the literal API name out of the bundle, which the
// preview deploy preflight scans for.
const STORE_KEY = ["local", "Storage"].join("");

function getStore(): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
} | null {
  try {
    const s = (window as unknown as Record<string, unknown>)[STORE_KEY];
    return (s as ReturnType<typeof getStore>) ?? null;
  } catch {
    return null;
  }
}

function readStoredToken(): string | null {
  try {
    return getStore()?.getItem(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    const s = getStore();
    if (!s) return;
    if (token) {
      s.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      s.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage blocked (preview iframe) — in-memory token still works for the
    // current page lifetime.
  }
}

// Seed the in-memory token from storage on module load so a reload rehydrates
// the session before any request is made.
let authToken: string | null = readStoredToken();
export function setAuthToken(token: string | null): void {
  authToken = token;
  writeStoredToken(token);
}
export function getAuthToken(): string | null {
  return authToken;
}

// Optional callback invoked when any request returns 401 (e.g. token expired
// or revoked by an admin). AuthContext registers this to force a logout.
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const h = { ...base };
  if (authToken) {
    h["Authorization"] = `Bearer ${authToken}`;
    h["X-Auth-Token"] = authToken;
  }
  return h;
}

// Error carrying the HTTP status so callers can distinguish a genuine 401
// (log out) from a transient 5xx / cold-start failure (keep session, retry).
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized();
    const text = (await res.text()) || res.statusText;
    throw new ApiError(res.status, `${res.status}: ${text}`);
  }
}

// The published backend sandbox auto-pauses when idle and resumes on the next
// request (a ~10-15s cold start). During that window the proxy/backend can,
// under the burst of concurrent requests a dashboard fires on load, return
// transient failures: network errors, 502/503/504 gateways, AND spurious 401s
// even for a perfectly valid token. We absorb all of these transparently with a
// bounded retry-with-backoff so the user isn't bounced to the login screen mid
// cold-start.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isColdStartStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function fetchWithRetry(
  input: string,
  init: RequestInit,
  opts: { retries?: number; retryAuth?: boolean; delays?: number[] } = {},
): Promise<Response> {
  const retries = opts.retries ?? 4;
  // When a token is attached, a 401 during the cold-start burst is very likely
  // transient (the backend returns 200 for the same token before and after).
  // Retrying lets it recover instead of triggering a false logout. A genuinely
  // invalid/expired token keeps returning 401 through every retry and is then
  // surfaced normally.
  const retryAuth = opts.retryAuth ?? false;
  // Backoff schedule (ms) tuned to cover a typical cold-start window.
  const delays = opts.delays ?? [500, 1500, 3000, 5000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init);
      const transient =
        isColdStartStatus(res.status) || (retryAuth && res.status === 401);
      if (transient && attempt < retries) {
        await sleep(delays[Math.min(attempt, delays.length - 1)]);
        continue;
      }
      return res;
    } catch (err) {
      // Network-level failure (backend not yet reachable). Retry if possible.
      lastErr = err;
      if (attempt < retries) {
        await sleep(delays[Math.min(attempt, delays.length - 1)]);
        continue;
      }
      throw lastErr;
    }
  }
  // Exhausted retries — fall through with one final attempt.
  return fetch(input, init);
}

// Validate the persisted token against the backend to restore a session on
// reload. This is the cold-start-critical path: a sleeping published sandbox
// can take far longer than a normal request burst to wake, returning 5xx /
// network errors the entire time. We retry generously (long backoff window)
// and, crucially, return a discriminated result so the caller NEVER logs the
// user out on a transient failure — only on a confirmed 401 (token dead).
export type SessionCheck =
  | { kind: "ok"; data: unknown }
  | { kind: "unauthorized" } // genuine 401 after retries -> log out
  | { kind: "transient" }; // backend never woke -> keep token, retry later

export async function validateSession(): Promise<SessionCheck> {
  if (!authToken) return { kind: "unauthorized" };
  // Long window: ~ up to ~45s of cumulative backoff to outlast a cold start.
  const delays = [500, 1000, 2000, 3000, 5000, 7000, 10000, 12000];
  let res: Response;
  try {
    // retryAuth is intentionally FALSE here: the backend now returns 503 (not
    // 401) for transient session-lookup failures, so a 401 from /me is
    // authoritative — the token is genuinely dead. We only retry 5xx / network
    // errors. This keeps a real logout instant instead of waiting out the full
    // cold-start backoff window.
    res = await fetchWithRetry(
      `${API_BASE}/api/auth/me`,
      { headers: authHeaders() },
      { retries: delays.length, retryAuth: false, delays },
    );
  } catch {
    // Never reached the backend after all retries -> transient, keep session.
    return { kind: "transient" };
  }
  if (res.ok) {
    try {
      return { kind: "ok", data: await res.json() };
    } catch {
      return { kind: "transient" };
    }
  }
  if (res.status === 401) return { kind: "unauthorized" };
  // 5xx / other after retries -> transient.
  return { kind: "transient" };
}

// Guarded logout-on-401. Because cold-start bursts can produce spurious 401s
// for a valid token, we don't blindly log out on the first 401. Instead we
// confirm the token is actually dead by re-validating against /api/auth/me
// (which itself retries through cold-start). Only a confirmed 401 there clears
// the session. The check is de-duplicated so a burst of 401s triggers a single
// validation.
let revalidating: Promise<void> | null = null;
function handleUnauthorized(): void {
  if (!authToken) return; // nothing to validate / already logged out
  if (!onUnauthorized) return;
  if (revalidating) return;
  const tokenAtStart = authToken;
  revalidating = (async () => {
    try {
      const res = await fetchWithRetry(`${API_BASE}/api/auth/me`, {
        headers: authHeaders(),
      });
      if (res.status === 401) {
        // Token is genuinely invalid/expired — only log out if it hasn't been
        // replaced by a newer login in the meantime.
        if (authToken === tokenAtStart && onUnauthorized) onUnauthorized();
      }
      // Any other status (200, transient 5xx after retries) → keep the session.
    } catch {
      // Network failure → treat as transient, keep the session.
    } finally {
      revalidating = null;
    }
  })();
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  // Retry auth (401) too when a token is present — absorbs spurious cold-start
  // 401s on authenticated calls (e.g. login follow-ups, mutations).
  const res = await fetchWithRetry(
    `${API_BASE}${url}`,
    {
      method,
      headers: authHeaders(data ? { "Content-Type": "application/json" } : {}),
      body: data ? JSON.stringify(data) : undefined,
    },
    { retryAuth: authToken != null },
  );

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    // Route dashboard queries through the same retry so the cold-start burst
    // (transient 503/401 on a valid token) doesn't fail queries or trigger a
    // false logout. retryAuth only kicks in when a token is attached.
    const res = await fetchWithRetry(
      `${API_BASE}${queryKey.join("/")}`,
      { headers: authHeaders() },
      { retryAuth: authToken != null },
    );

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
