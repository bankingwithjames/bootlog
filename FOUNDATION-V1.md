# BootLog — Foundation v1 (Production Ready)

**Locked:** 2026-06-09
**Git tag:** `foundation-v1` (commit `39a28f4`)
**Backup branch:** `foundation-v1-branch`
**Source archive:** `../booting-app-snapshots/foundation-v1-source.tar.gz`
**Live URL:** https://bootlog.pplx.app

This is the locked, production-ready baseline. Any future edits start from here, and
you can always revert back to this exact state.

---

## What's in Foundation v1

- **Supabase Postgres persistence** — users, sessions, boots, boot_requests, paid_snapshots, settings
- **Persistent sessions** that survive server restarts (the original login-reset bug is fixed)
- **Role-based auth** — admin / enforcer / attendant, scrypt password hashing
- **Seeded accounts** — admin, chop1 (enforcer), mari1 (attendant); all force a password change on first login
- **Stripe paid-car lookup** via the credential proxy
- **Millennialz Parking branding** — header logo, login logo, favicons
- **Security reviewed** — clean pre-publish scan (no exposed secrets, all mutation routes auth-protected)

---

## How to revert to Foundation v1

### Easiest — run the restore script
```bash
bash RESTORE-FOUNDATION-V1.sh
npm ci          # only if dependencies changed
npm run build
# restart the server
```
The script automatically backs up your current work (git stash) before restoring.

### Manual — git
```bash
# discard ALL changes since v1 and return to the locked snapshot:
git checkout foundation-v1 -- .
npm run build
```
Or to inspect v1 without changing your working files:
```bash
git switch -c look-at-v1 foundation-v1
```

### Manual — archive fallback (if git history is ever lost)
```bash
tar xzf ../booting-app-snapshots/foundation-v1-source.tar.gz -C .
npm ci && npm run build
```

---

## Important notes

- Reverting **code** does NOT touch your **live Supabase database** — your real data
  (boots, paid cars, accounts) is stored in Supabase and is unaffected by a code restore.
- `.env` (your Supabase credentials) is intentionally **not** in the snapshot and is left
  in place during a restore.
- `node_modules` and `dist/` are not snapshotted; rebuild with `npm ci && npm run build`.

---

## Working safely going forward

Recommended workflow so v1 always stays intact:

```bash
# start a new feature/edit on its own branch:
git switch -c my-change master

# ...make edits, test...

git add -A && git commit -m "describe the change"
```

If an edit goes wrong, revert anytime with `bash RESTORE-FOUNDATION-V1.sh`.
