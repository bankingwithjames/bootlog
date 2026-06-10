// Lightweight Google Maps JS API loader for Field Mode's shift map.
//
// Loads the Maps JS API exactly once (idempotent) using the build-time key
// VITE_GOOGLE_MAPS_KEY. The key is referrer- + API-restricted, so it is safe to
// ship in the client bundle (Google's standard pattern for the JS API). If the
// key is absent at build time, `loadGoogleMaps` rejects and callers fall back to
// a schematic map — the rest of the shift flow still works.
//
// We deliberately avoid @types/google.maps to keep the dependency surface small;
// the returned namespace is typed loosely as `any`.

let loaderPromise: Promise<any> | null = null;

export function googleMapsKey(): string {
  // Vite inlines this at build time; empty string when unset.
  return (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) ?? "";
}

export function hasGoogleMapsKey(): boolean {
  return googleMapsKey().trim().length > 0;
}

export function loadGoogleMaps(): Promise<any> {
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise((resolve, reject) => {
    const w = window as any;
    // Already loaded (e.g. hot reload).
    if (typeof window !== "undefined" && w.google?.maps) {
      resolve(w.google.maps);
      return;
    }

    const key = googleMapsKey().trim();
    if (!key) {
      reject(new Error("VITE_GOOGLE_MAPS_KEY is not set"));
      return;
    }

    const existing = document.getElementById(
      "gmaps-js-sdk",
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(w.google.maps));
      existing.addEventListener("error", () =>
        reject(new Error("Google Maps failed to load")),
      );
      return;
    }

    const script = document.createElement("script");
    script.id = "gmaps-js-sdk";
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key,
    )}&libraries=marker&loading=async`;
    script.onload = () => {
      const maps = w.google?.maps;
      if (maps) resolve(maps);
      else
        reject(new Error("Google Maps loaded but window.google.maps missing"));
    };
    script.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.appendChild(script);
  });

  return loaderPromise;
}
