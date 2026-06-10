#!/usr/bin/env bash
#
# Restore BootLog to Foundation v1 (production-ready, locked 2026-06-09).
#
# This reverts ALL source code in this project back to the Foundation v1 snapshot.
# It does NOT touch:
#   - .env (your Supabase credentials stay in place)
#   - node_modules (run `npm ci` after if dependencies changed)
#   - your live Supabase database (data is untouched — this only restores code)
#
# USAGE:
#   bash RESTORE-FOUNDATION-V1.sh
#
# Two restore methods are provided. Method A (git) is preferred.
# Method B (archive) is a fallback if git history is ever lost.

set -e
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "=============================================="
echo " Restoring BootLog -> Foundation v1"
echo "=============================================="
echo "Project: $PROJECT_DIR"
echo

# ---- Method A: git (preferred) ----
if git rev-parse --verify --quiet foundation-v1 >/dev/null 2>&1; then
  echo "[A] git tag 'foundation-v1' found."
  echo "    Saving your current work to a backup branch first..."
  STAMP="pre-restore-$(date +%Y%m%d-%H%M%S)"
  git add -A >/dev/null 2>&1 || true
  git stash push -u -m "$STAMP" >/dev/null 2>&1 || true
  echo "    (current uncommitted work stashed as: $STAMP — recover with 'git stash list')"
  echo "    Checking out Foundation v1 source..."
  git checkout -- . 2>/dev/null || true
  git checkout foundation-v1 -- . 
  echo
  echo "    DONE. Source restored from git tag foundation-v1."
  echo "    Next steps:"
  echo "      npm ci            # if dependencies changed"
  echo "      npm run build"
  echo "      restart the server"
  exit 0
fi

# ---- Method B: archive fallback ----
ARCHIVE="$PROJECT_DIR/../booting-app-snapshots/foundation-v1-source.tar.gz"
if [ -f "$ARCHIVE" ]; then
  echo "[B] git tag missing; using archive fallback: $ARCHIVE"
  echo "    Extracting over current source (this overwrites tracked source files)..."
  tar xzf "$ARCHIVE" -C "$PROJECT_DIR"
  echo
  echo "    DONE. Source restored from archive."
  echo "    Next steps:"
  echo "      npm ci"
  echo "      npm run build"
  echo "      restart the server"
  exit 0
fi

echo "ERROR: Neither the git tag 'foundation-v1' nor the archive snapshot was found."
echo "Cannot restore automatically."
exit 1
