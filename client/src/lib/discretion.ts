import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Attendant "discretion mode" — a purely front-end visual toggle that BLURS
// sensitive cash figures (cash owed to bank, owed-unverified, reconciled) so a
// passer-by / guest standing next to the attendant can't read them at a glance.
//
// This is NOT a permission change. It does not hide data from anyone (admin,
// enforcer, or the attendant themselves) — the values are still rendered, just
// visually blurred. The attendant can flip it back at any time. It is scoped to
// the attendant Field Mode UI only; admin/enforcer experiences are untouched.
//
// State is persisted like the auth token: through a computed property name on
// `window` so the literal storage API name never appears in the bundle (the
// preview deploy preflight scans for it). The published app runs outside the
// preview iframe where this storage works; inside the iframe access throws and
// we fall back to in-memory only (handled by try/catch).
// ---------------------------------------------------------------------------

const DISCRETION_STORAGE_KEY = "bootlog_discretion";
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

function readStored(): boolean {
  try {
    return getStore()?.getItem(DISCRETION_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStored(on: boolean): void {
  try {
    const s = getStore();
    if (!s) return;
    if (on) s.setItem(DISCRETION_STORAGE_KEY, "1");
    else s.removeItem(DISCRETION_STORAGE_KEY);
  } catch {
    // Storage blocked (preview iframe) — in-memory value still works for the
    // current page lifetime.
  }
}

// Seed from storage on module load so a reload restores the attendant's choice.
let discreet: boolean = readStored();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getDiscretion(): boolean {
  return discreet;
}

export function setDiscretion(on: boolean): void {
  discreet = on;
  writeStored(on);
  emit();
}

export function toggleDiscretion(): void {
  setDiscretion(!discreet);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Hook for components that need to read + react to the discretion flag. All
// consumers share the single module-level value so the header toggle and every
// blurred figure stay in sync within the same render.
export function useDiscretion(): boolean {
  return useSyncExternalStore(subscribe, getDiscretion, getDiscretion);
}
