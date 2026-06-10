// ---------------------------------------------------------------------------
// Server-side geocoding + geofence math
// ---------------------------------------------------------------------------
// Geocoding runs ENTIRELY server-side: the request goes to the Google
// Geocoding API and the credential proxy injects the API key on the outbound
// HTTPS call (so the key never appears in this code, env, or the client).
//
// In the published sandbox the proxy is gone; geocoding is only used lazily
// the first time a location needs a geofence center, and the result is stored,
// so a location geocoded once during preview keeps working after publish.
// ---------------------------------------------------------------------------

// Direct Google host (used as a fallback if no proxy credential is present —
// e.g. the published sandbox, where it will simply 403/REQUEST_DENIED and the
// caller degrades to the schematic map).
const GOOGLE_HOST = "https://maps.googleapis.com";
const GEOCODE_PATH = "/maps/api/geocode/json";
const STATICMAP_PATH = "/maps/api/staticmap";

// Credential-proxy wiring. In the dev/preview sandbox, `start_server` injects:
//   CUSTOM_CRED_MAPS_GOOGLEAPIS_COM_URL   -> the agent pass-through base URL
//   CUSTOM_CRED_MAPS_GOOGLEAPIS_COM_TOKEN -> the per-thread proxy token
// The proxy knows the real target host from the credential and injects the
// actual Google API key on the outbound request, so the key never appears in
// this code, env, or the client. We send the token as `x-api-key` and append
// the Google API path to the pass-through base.
const PROXY_BASE = process.env.CUSTOM_CRED_MAPS_GOOGLEAPIS_COM_URL || "";
const PROXY_TOKEN = process.env.CUSTOM_CRED_MAPS_GOOGLEAPIS_COM_TOKEN || "";
const PROXY_ENABLED = Boolean(PROXY_BASE && PROXY_TOKEN);

// Build the request URL + headers for a Google Maps API call given the path
// after the host (e.g. "/maps/api/geocode/json?address=..."). When the proxy
// credential is present we route through the pass-through base and attach the
// token header; otherwise we hit Google directly (which will fail without a
// key, by design, so the UI falls back to the schematic map).
function googleMapsRequest(pathAndQuery: string): {
  url: string;
  init: RequestInit;
} {
  if (PROXY_ENABLED) {
    const base = PROXY_BASE.replace(/\/$/, "");
    return {
      url: `${base}${pathAndQuery}`,
      init: { headers: { "x-api-key": PROXY_TOKEN } },
    };
  }
  return { url: `${GOOGLE_HOST}${pathAndQuery}`, init: {} };
}

export interface LatLng {
  lat: number;
  lng: number;
}

// Geocode a free-text address to a single best lat/lng. Returns null when the
// address is empty, not found, or the request fails (caller decides how to
// surface that — typically a 422 "address not geocodable yet").
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const q = (address ?? "").trim();
  if (!q) return null;
  try {
    const { url, init } = googleMapsRequest(
      `${GEOCODE_PATH}?address=${encodeURIComponent(q)}`,
    );
    const res = await fetch(url, init);
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[geo] geocode HTTP ${res.status} for "${q}"`);
      return null;
    }
    const data: any = await res.json();
    if (data.status !== "OK" || !Array.isArray(data.results) || !data.results[0]) {
      // eslint-disable-next-line no-console
      console.error(`[geo] geocode status=${data.status} for "${q}"`);
      return null;
    }
    const loc = data.results[0].geometry?.location;
    if (
      !loc ||
      typeof loc.lat !== "number" ||
      typeof loc.lng !== "number"
    ) {
      return null;
    }
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[geo] geocode failed for "${q}"`, err);
    return null;
  }
}

// Build a Google Static Maps URL for a geofenced lot. The credential proxy
// injects the API key on the outbound request, so no key appears here, in env,
// or in the client. We approximate the geofence circle with a polygon path
// (Static Maps has no native circle) and drop a marker for the lot center and,
// when known, the attendant's current position.
export function buildStaticMapUrl(opts: {
  center: LatLng;
  radiusMeters: number;
  user?: LatLng | null;
  widthPx: number;
  heightPx: number;
  scale?: 1 | 2;
}): string {
  const { center, radiusMeters, user, widthPx, heightPx } = opts;
  const scale = opts.scale ?? 2;

  // Approximate the geofence circle as a 48-point polygon. Convert the metric
  // radius to degrees: latitude is ~111,320 m/deg; longitude shrinks by
  // cos(lat).
  const latRadDeg = radiusMeters / 111_320;
  const lngRadDeg =
    radiusMeters / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  const pts: string[] = [];
  const STEPS = 48;
  for (let i = 0; i <= STEPS; i++) {
    const theta = (i / STEPS) * 2 * Math.PI;
    const lat = center.lat + latRadDeg * Math.sin(theta);
    const lng = center.lng + lngRadDeg * Math.cos(theta);
    pts.push(`${lat.toFixed(6)},${lng.toFixed(6)}`);
  }
  const circlePath = `path=color:0x1f6febcc|weight:2|fillcolor:0x1f6feb22|${pts.join(
    "|",
  )}`;

  // Lot center marker (navy) + optional user marker (blue inside / red outside).
  const lotMarker = `markers=color:0x10243f|size:mid|${center.lat.toFixed(
    6,
  )},${center.lng.toFixed(6)}`;
  const params = [
    `size=${widthPx}x${heightPx}`,
    `scale=${scale}`,
    `maptype=roadmap`,
    circlePath,
    lotMarker,
  ];
  if (user) {
    const inside = distanceMeters(user, center) <= radiusMeters;
    const color = inside ? "0x1f6feb" : "0xc0392b";
    params.push(
      `markers=color:${color}|size:small|${user.lat.toFixed(6)},${user.lng.toFixed(
        6,
      )}`,
    );
  } else {
    // No user fix — center on the lot so the geofence fills the frame nicely.
    params.push(`center=${center.lat.toFixed(6)},${center.lng.toFixed(6)}`);
    params.push(`zoom=16`);
  }
  // Returns the Google API path + query (no host). fetchStaticMap routes it
  // through the credential proxy (dev) or directly to Google (published).
  return `${STATICMAP_PATH}?${params.join("&")}`;
}

// Fetch a Static Maps image server-side (proxy injects the key) and return the
// raw bytes + content type, or null on failure.
export async function fetchStaticMap(
  pathAndQuery: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const { url, init } = googleMapsRequest(pathAndQuery);
    const res = await fetch(url, init);
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[geo] staticmap HTTP ${res.status}`);
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "image/png";
    if (!contentType.startsWith("image/")) {
      // Google returns text/plain on auth/restriction errors.
      // eslint-disable-next-line no-console
      console.error(`[geo] staticmap non-image response (${contentType})`);
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    return { body: Buffer.from(arrayBuf), contentType };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[geo] staticmap fetch failed", err);
    return null;
  }
}

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two points in meters (haversine).
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// True when `point` is within `radiusMeters` of `center`.
export function isInsideGeofence(
  point: LatLng,
  center: LatLng,
  radiusMeters: number,
): boolean {
  return distanceMeters(point, center) <= radiusMeters;
}
