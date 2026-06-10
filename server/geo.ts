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

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

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
    const url = `${GEOCODE_URL}?address=${encodeURIComponent(q)}`;
    const res = await fetch(url);
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
