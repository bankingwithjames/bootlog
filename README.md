# BootLog

Vehicle booting & parking enforcement management app for Millennialz Parking, LLC.
Built with React + Vite (frontend), Express (API), Drizzle ORM, and Supabase (database).

## Edit from anywhere → live site updates

Live URL: **https://bootlog.vercel.app**

This repo deploys to Vercel. Edit the code in any tool — Cursor, Claude Code,
GitHub Copilot, VS Code, or the GitHub web editor — then publish with one command:

```bash
npm run deploy        # builds and pushes a new production deploy to bootlog.vercel.app
```

The Supabase database lives outside the host, so it keeps working no matter where
the app is deployed.

### Optional: true auto-deploy on every git push

To make every `git push` to `main` deploy automatically (no `npm run deploy` step),
authorize the Vercel GitHub App once — this is a one-time browser step that only the
repo owner can do:

1. Open the Vercel project → **Settings → Git**.
2. Click **Connect Git Repository**, choose **GitHub**, and authorize the Vercel app
   for `bankingwithjames/bootlog` when GitHub prompts you.

Once connected, every push to `main` triggers an automatic build and deploy.

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

Vercel uses a separate serverless build (`npm run build:vercel`) that bundles the
entire Express app into a single self-contained `dist/server.cjs` handler. The
`vercel.json` `builds` array ships that bundle as-is to a Vercel Function and serves
`dist/public` as static assets from the CDN. This is wired up already — `npm run deploy`
runs it for you.

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
