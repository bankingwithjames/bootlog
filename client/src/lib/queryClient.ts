import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Auth token. The published app runs OUTSIDE the sandboxed iframe, so
// localStorage is available and we persist the token there to keep the user
// signed in across reloads / browser reopens ("keep me signed in"). When the
// app runs inside the preview iframe, storage access throws, so every storage
// call is wrapped in try/catch and we gracefully fall back to in-memory only.
const TOKEN_STORAGE_KEY = "bootlog_token";

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
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

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// The published backend sandbox auto-pauses when idle and resumes on the next
// request (a ~10-15s cold start). During that window the first request(s) can
// fail with a network error or a 502/503/504 gateway response. We absorb that
// transparently with a bounded retry-with-backoff so the user doesn't see a
// spurious "failed" message before the backend warms up.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isColdStartStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function fetchWithRetry(
  input: string,
  init: RequestInit,
  retries = 4,
): Promise<Response> {
  // Backoff schedule (ms) tuned to cover a typical cold-start window.
  const delays = [500, 1500, 3000, 5000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init);
      // Retry transient gateway errors (cold start), but only if we have
      // attempts left. A 401/400/etc. is a real answer — return immediately.
      if (isColdStartStatus(res.status) && attempt < retries) {
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
  // Exhausted retries on gateway errors — fall through with one final attempt.
  return fetch(input, init);
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetchWithRetry(`${API_BASE}${url}`, {
    method,
    headers: authHeaders(data ? { "Content-Type": "application/json" } : {}),
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      headers: authHeaders(),
    });

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
