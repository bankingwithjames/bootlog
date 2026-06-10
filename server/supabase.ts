import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Server-side Supabase client.
// ---------------------------------------------------------------------------
// The anon (public) key is used SERVER-SIDE ONLY. It is never shipped to the
// browser — the React frontend talks to our Express API, which holds the key.
// Row Level Security on the Supabase side keeps the tables locked to this app.
//
// Credentials come from env (.env in dev; injected sandbox env vars in the
// published *.pplx.app environment via publish_website `credentials`).
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Fail fast with a clear message rather than producing confusing 401s later.
  throw new Error(
    "Missing SUPABASE_URL / SUPABASE_ANON_KEY. Set them in .env (dev) or pass " +
      "them via publish_website credentials (production).",
  );
}

// Node < 22 has no global WebSocket, and supabase-js eagerly constructs a
// Realtime client. We never use Realtime (data-only access), so give it an
// inert transport to avoid the "Node.js 20 detected without native WebSocket
// support" crash at startup.
class NoopWebSocket {
  constructor() {
    /* no-op: Realtime is unused */
  }
}

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: NoopWebSocket as unknown as never },
  },
);

export default supabase;
