# BootLog

Vehicle booting & parking enforcement management app for Millennialz Parking, LLC.
Built with React + Vite (frontend), Express (API), Drizzle ORM, and Supabase (database).

## Edit from anywhere → live site auto-updates

This repo is wired for continuous deployment via Vercel:

1. Edit the code in any tool — Cursor, Claude Code, GitHub Copilot, VS Code, or the GitHub web editor.
2. Commit and push to the `main` branch.
3. Vercel auto-builds and deploys to the live URL within ~1–2 minutes.

The Supabase database lives outside the host, so it keeps working no matter where the app is deployed.

## Local development

```bash
npm install
cp .env.example .env   # then fill in real values
npm run dev            # starts Express + Vite on http://localhost:5000
```

## Build & production

```bash
npm run build          # outputs dist/index.cjs (server) + dist/public (static)
npm start              # runs the production server (reads PORT env var, default 5000)
```

## Environment variables

See `.env.example` for the full list. The required ones are `SUPABASE_URL` and
`SUPABASE_ANON_KEY`. Set these in **Vercel → Project → Settings → Environment Variables**
so the deployed site can reach the database. Never commit your real `.env`.

## Architecture notes

- Single Express process serves both the API (`/api/*`) and the built frontend.
- The server respects `process.env.PORT` (Vercel sets this automatically).
- Routing uses hash-based paths on the frontend so it works behind any host.
- All browser storage (localStorage/sessionStorage/indexedDB) is intentionally avoided.

## Roles & access

- **admin** — full administrative access
- **enforcer** — field enforcement (boot placement, lookup, active enforcement)
- **attendant** — shift check-in, vehicle intake, inventory
