// Side-effect module: load environment variables before anything else imports them.
// MUST be imported first (before any module that reads process.env, e.g. supabase.ts).
//
// .env.local (gitignored) is loaded first with override, so local dev can point at
// staging without modifying the committed production .env. Anything not set in
// .env.local is then filled from .env.
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", override: true });
dotenv.config();
