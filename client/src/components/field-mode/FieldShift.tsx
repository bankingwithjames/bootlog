import { useEffect, useMemo, useRef, useState } from "react";
import { format, parseISO } from "date-fns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Crosshair,
  MapPin,
  MessageSquare,
  Navigation,
  Play,
  Square,
  User as UserIcon,
  Calendar,
  Loader2,
} from "lucide-react";
import type { Location, Shift } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FIELD, FIELD_FONT, FIELD_MONO } from "./FieldShell";

// ---------------------------------------------------------------------------
// FieldShift — attendant shift check-in / check-out with a GPS geofence HARD
// BLOCK. Wires the four states from the approved page2_shift.html mockup to the
// live v2 backend:
//   1. Outside lot     → red banner, check-in DISABLED, "get directions" CTA
//   2. Inside lot      → green banner, orange "Check In" CTA, SMS note
//   3. On shift        → live timer, "Verified ✓", orange-outline "Check Out"
//   4. Checked out      → summary recap (in/out/total), SMS-fired note
//
// The geofence gate is enforced authoritatively server-side (POST
// /api/shifts/checkin returns 403 OUTSIDE_GEOFENCE). The client-side
// inside/outside calc only drives the UI so the attendant gets instant feedback
// — it is never the source of truth for whether a shift may open.
// ---------------------------------------------------------------------------

type GeofenceInfo = {
  locationId: number;
  locationName: string;
  address: string;
  center: { lat: number; lng: number };
  radiusMeters: number;
};

type GeoPosition = {
  lat: number;
  lng: number;
  accuracy: number;
};

// Haversine distance in meters (mirrors server/geo.ts so UI matches the gate).
function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function metersToMiles(m: number): number {
  return m / 1609.344;
}

function distanceLabel(m: number): string {
  const mi = metersToMiles(m);
  if (mi >= 0.1) return `${mi.toFixed(1)} mi`;
  return `${Math.round(m)} m`;
}

function elapsedLabel(startIso: string, now: number): string {
  let start: number;
  try {
    start = parseISO(startIso).getTime();
  } catch {
    return "00:00:00";
  }
  let s = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function durationLabel(startIso: string, endIso: string): string {
  try {
    const ms = parseISO(endIso).getTime() - parseISO(startIso).getTime();
    const mins = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
  } catch {
    return "—";
  }
}

function timeLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "h:mm a");
  } catch {
    return "—";
  }
}

export function FieldShift({
  assignedLot,
  activeShift,
  onBack,
  onShiftChange,
}: {
  assignedLot: Location | null;
  activeShift: Shift | null;
  onBack: () => void;
  // Lets FieldMode lift the shift status into the header bar after mutations.
  onShiftChange: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Live "now" ticker for the active-shift timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activeShift || activeShift.checkOutAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeShift]);

  // Most-recently-closed shift, surfaced for the summary state after checkout.
  const [closedShift, setClosedShift] = useState<Shift | null>(null);

  // Browser geolocation.
  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoPending, setGeoPending] = useState(false);
  const watchId = useRef<number | null>(null);

  const requestLocation = () => {
    if (!("geolocation" in navigator)) {
      setGeoError("Location services aren't available on this device.");
      return;
    }
    setGeoPending(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 0,
        });
        setGeoPending(false);
      },
      (err) => {
        setGeoPending(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Enable it to check in."
            : "Couldn't get your location. Try again.",
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 },
    );
  };

  // Continuously watch position while we're not on an open shift so the
  // inside/outside indicator stays live as the attendant approaches the lot.
  useEffect(() => {
    if (activeShift && !activeShift.checkOutAt) return; // on shift → no need
    if (!("geolocation" in navigator)) return;
    requestLocation();
    watchId.current = navigator.geolocation.watchPosition(
      (pos) =>
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 0,
        }),
      () => {
        /* keep last good fix */
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => {
      if (watchId.current != null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShift?.id, activeShift?.checkOutAt]);

  // Geofence for the assigned lot (geocoded server-side, cached).
  const geofenceQuery = useQuery<GeofenceInfo>({
    queryKey: ["/api/shifts/geofence", assignedLot?.id],
    enabled: assignedLot != null,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/shifts/geofence/${assignedLot!.id}`,
      );
      return res.json();
    },
    retry: false,
    staleTime: 60_000,
  });

  const geofence = geofenceQuery.data ?? null;

  // Client-side inside/outside (UI only; server is authoritative).
  const distance = useMemo(() => {
    if (!geofence || !position) return null;
    return distanceMeters(position, geofence.center);
  }, [geofence, position]);

  const inside = useMemo(() => {
    if (distance == null || !geofence) return false;
    return distance <= geofence.radiusMeters;
  }, [distance, geofence]);

  // --- Mutations -----------------------------------------------------------
  const checkIn = useMutation({
    mutationFn: async () => {
      if (!assignedLot || !position) throw new Error("Missing location data.");
      const res = await apiRequest("POST", "/api/shifts/checkin", {
        locationId: assignedLot.id,
        latitude: position.lat,
        longitude: position.lng,
        accuracy: position.accuracy,
      });
      return (await res.json()) as Shift;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/shifts/active"] });
      setClosedShift(null);
      onShiftChange();
      toast({
        title: "Checked in",
        description: "Your shift has started. The enforcer & admin were notified.",
      });
    },
    onError: (err: any) => {
      const msg = String(err?.message ?? "");
      const friendly = /OUTSIDE_GEOFENCE|inside the lot/i.test(msg)
        ? "You must be inside the lot to check in. Move closer and try again."
        : msg.replace(/^\d+:\s*/, "") || "Couldn't check in. Try again.";
      toast({
        title: "Check-in blocked",
        description: friendly,
        variant: "destructive",
      });
    },
  });

  const checkOut = useMutation({
    mutationFn: async () => {
      if (!activeShift) throw new Error("No open shift.");
      const body =
        position != null
          ? { latitude: position.lat, longitude: position.lng }
          : {};
      const res = await apiRequest(
        "PATCH",
        `/api/shifts/${activeShift.id}/checkout`,
        body,
      );
      return (await res.json()) as Shift;
    },
    onSuccess: (closed) => {
      setClosedShift(closed);
      queryClient.invalidateQueries({ queryKey: ["/api/shifts/active"] });
      onShiftChange();
      toast({
        title: "Shift checked out",
        description: "Your hours were logged. Admin & enforcer were notified.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Check-out failed",
        description:
          String(err?.message ?? "").replace(/^\d+:\s*/, "") ||
          "Couldn't check out. Try again.",
        variant: "destructive",
      });
    },
  });

  // --- Directions ----------------------------------------------------------
  const openDirections = () => {
    if (!geofence) return;
    const dest =
      geofence.address && geofence.address.trim().length > 0
        ? encodeURIComponent(geofence.address)
        : `${geofence.center.lat},${geofence.center.lng}`;
    window.open(
      `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  // -------------------------------------------------------------------------
  // Render — decide which of the four states to show.
  // -------------------------------------------------------------------------
  const onShift = !!activeShift && !activeShift.checkOutAt;
  const showSummary = !onShift && !!closedShift;

  const lotName = geofence?.locationName ?? assignedLot?.name ?? "Your lot";
  const headerSub = onShift
    ? `${lotName} · On shift`
    : `Assigned: ${lotName}`;
  const headerTitle = onShift
    ? "Active Shift"
    : showSummary
      ? "Shift Complete"
      : "Start Shift";

  return (
    <div
      className="flex flex-col"
      style={{ fontFamily: FIELD_FONT, color: FIELD.ink }}
      data-testid="field-shift"
    >
      {/* Sub-page header with back affordance */}
      <div
        className="px-4 pb-4 pt-[15px] text-white"
        style={{
          background: `linear-gradient(160deg, ${FIELD.header}, ${FIELD.header2})`,
        }}
      >
        <div className="flex items-center gap-[11px]">
          <button
            type="button"
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-[9px]"
            style={{ background: "rgba(255,255,255,.12)" }}
            aria-label="Back"
            data-testid="button-shift-back"
          >
            <ArrowLeft className="h-[19px] w-[19px]" />
          </button>
          <div className="text-base font-bold" data-testid="text-shift-title">
            {headerTitle}
          </div>
        </div>
        <div className="mt-[11px] flex items-center gap-[7px] text-[12.5px] font-medium text-white/75">
          <MapPin className="h-[15px] w-[15px] opacity-80" />
          <span data-testid="text-shift-sub">{headerSub}</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-[15px] px-4 pb-[110px] pt-[18px]">
        {assignedLot == null ? (
          <NoLot />
        ) : showSummary ? (
          <SummaryState shift={closedShift!} onBackToDash={onBack} />
        ) : onShift ? (
          <ActiveState
            shift={activeShift!}
            now={now}
            onCheckOut={() => checkOut.mutate()}
            checkingOut={checkOut.isPending}
          />
        ) : (
          <PreShiftState
            geofence={geofence}
            geofenceLoading={geofenceQuery.isLoading}
            geofenceError={
              geofenceQuery.isError
                ? "This lot's address can't be located yet. Ask your admin to set a valid street address."
                : null
            }
            position={position}
            distance={distance}
            inside={inside}
            geoError={geoError}
            geoPending={geoPending}
            onRetryLocation={requestLocation}
            onCheckIn={() => checkIn.mutate()}
            checkingIn={checkIn.isPending}
            onDirections={openDirections}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShiftMap — geofence map orchestrator with a three-tier fallback chain:
//
//   1. Interactive Google JS map (pan/zoom) — only when a browser-only build
//      key (VITE_GOOGLE_MAPS_KEY) is present. Renders a real google.maps.Circle
//      geofence overlay, a navy lot marker, and a color-coded user marker. This
//      is the PRODUCTION map path (the published sandbox has no credential
//      proxy, so the server static route can't work there).
//   2. Server-proxied Google Static Map (StaticMap) — used in preview/dev where
//      the credential proxy injects the server key server-side. Never ships a
//      key to the browser.
//   3. Schematic grid — last-resort offline fallback.
//
// The map style/framing matches the approved Signal Blue static mock.
// ---------------------------------------------------------------------------
const MAP_HEIGHT = 188;
const BROWSER_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as
  | string
  | undefined;

function ShiftMap({
  locationId,
  center,
  radiusMeters,
  user,
  inside,
}: {
  locationId: number;
  center: { lat: number; lng: number };
  radiusMeters: number;
  user: { lat: number; lng: number } | null;
  inside: boolean;
}) {
  // If a referrer-locked browser key was baked in at build time, prefer the
  // interactive JS map. If it fails to load (network/quota/referrer), fall
  // through to the server static image, then the schematic.
  if (BROWSER_MAPS_KEY) {
    return (
      <InteractiveMap
        center={center}
        radiusMeters={radiusMeters}
        user={user}
        inside={inside}
        fallback={
          <StaticMap locationId={locationId} user={user} inside={inside} />
        }
      />
    );
  }
  return <StaticMap locationId={locationId} user={user} inside={inside} />;
}

// ---------------------------------------------------------------------------
// Google Maps JS API loader — loads the script exactly once and resolves when
// the `google.maps` namespace is ready. Returns a shared promise so multiple
// mounts don't inject duplicate <script> tags.
// ---------------------------------------------------------------------------
let mapsLoaderPromise: Promise<void> | null = null;
function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if ((window as any).google?.maps) return Promise.resolve();
  if (mapsLoaderPromise) return mapsLoaderPromise;
  mapsLoaderPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById("gmaps-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("maps load error")));
      return;
    }
    const s = document.createElement("script");
    s.id = "gmaps-js";
    s.async = true;
    s.defer = true;
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key,
    )}&libraries=marker`;
    s.addEventListener("load", () => resolve());
    s.addEventListener("error", () => {
      mapsLoaderPromise = null; // allow a retry on next mount
      reject(new Error("maps load error"));
    });
    document.head.appendChild(s);
  });
  return mapsLoaderPromise;
}

// ---------------------------------------------------------------------------
// InteractiveMap — pan/zoom Google JS map with a real geofence Circle overlay,
// navy lot marker, and color-coded user marker. Falls back to `fallback` if
// the script can't load.
// ---------------------------------------------------------------------------
function InteractiveMap({
  center,
  radiusMeters,
  user,
  inside,
  fallback,
}: {
  center: { lat: number; lng: number };
  radiusMeters: number;
  user: { lat: number; lng: number } | null;
  inside: boolean;
  fallback: React.ReactNode;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const circleRef = useRef<any>(null);
  const lotMarkerRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Load the script + create the base map / static overlays once.
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(BROWSER_MAPS_KEY as string)
      .then(() => {
        if (cancelled || !elRef.current) return;
        const g = (window as any).google;
        const map = new g.maps.Map(elRef.current, {
          center,
          zoom: 16,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "greedy",
          clickableIcons: false,
          styles: [
            { featureType: "poi", stylers: [{ visibility: "off" }] },
            { featureType: "transit", stylers: [{ visibility: "off" }] },
          ],
        });
        mapRef.current = map;

        // Geofence circle (Signal Blue accent).
        circleRef.current = new g.maps.Circle({
          map,
          center,
          radius: radiusMeters,
          strokeColor: FIELD.accent,
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillColor: FIELD.accent,
          fillOpacity: 0.12,
          clickable: false,
        });

        // Navy lot marker at the geofence center.
        lotMarkerRef.current = new g.maps.Marker({
          map,
          position: center,
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: 6,
            fillColor: FIELD.header,
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 3,
          },
          zIndex: 2,
        });

        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the circle/center in sync if the lot config changes.
  useEffect(() => {
    if (!ready || !circleRef.current) return;
    circleRef.current.setCenter(center);
    circleRef.current.setRadius(radiusMeters);
    lotMarkerRef.current?.setPosition(center);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, center.lat, center.lng, radiusMeters]);

  // Add / update / color the user marker as the GPS fix moves.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const g = (window as any).google;
    if (!user) {
      userMarkerRef.current?.setMap(null);
      userMarkerRef.current = null;
      return;
    }
    const color = inside ? FIELD.accent : "#c0392b";
    const icon = {
      path: g.maps.SymbolPath.CIRCLE,
      scale: 7,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 3,
    };
    if (!userMarkerRef.current) {
      userMarkerRef.current = new g.maps.Marker({
        map: mapRef.current,
        position: user,
        icon,
        zIndex: 3,
      });
    } else {
      userMarkerRef.current.setPosition(user);
      userMarkerRef.current.setIcon(icon);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user?.lat, user?.lng, inside]);

  if (failed) {
    return <>{fallback}</>;
  }
  return (
    <div
      className="relative overflow-hidden rounded-[0.875rem]"
      style={{ height: MAP_HEIGHT, border: `1px solid ${FIELD.line}`, background: "#eef2f6" }}
      data-testid="shift-map"
    >
      <div ref={elRef} className="h-full w-full" data-testid="shift-map-interactive" />
      {!ready && (
        <div className="absolute inset-0">
          <MapSkeleton label="Loading map…" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StaticMap — server-proxied Google Static Map with geofence circle + lot pin +
// user dot. The image is fetched through /api/shifts/staticmap (the API key is
// injected server-side by the credential proxy and never ships to the browser).
// We fetch via apiRequest so the auth token is attached, then render the bytes
// as an object URL. Falls back to a schematic grid if the image can't load.
// ---------------------------------------------------------------------------
function StaticMap({
  locationId,
  user,
  inside,
}: {
  locationId: number;
  user: { lat: number; lng: number } | null;
  inside: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  // Round the user position so tiny GPS jitter doesn't refetch the image every
  // second; ~5 decimals ≈ 1m.
  const userKey = user
    ? `${user.lat.toFixed(5)},${user.lng.toFixed(5)}`
    : "none";

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (user) {
      params.set("lat", String(user.lat));
      params.set("lng", String(user.lng));
    }
    params.set("w", "600");
    params.set("h", "376");
    apiRequest(
      "GET",
      `/api/shifts/staticmap/${locationId}?${params.toString()}`,
    )
      .then((res) => res.blob())
      .then((blob) => {
        if (cancelled) return;
        if (!blob.type.startsWith("image/")) {
          setFailed(true);
          return;
        }
        const objUrl = URL.createObjectURL(blob);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = objUrl;
        setSrc(objUrl);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, userKey]);

  // Clean up the last object URL on unmount.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  if (failed) {
    return <SchematicMap inside={inside} />;
  }
  if (!src) {
    return <MapSkeleton label="Loading map…" />;
  }
  return (
    <div
      className="relative overflow-hidden rounded-[0.875rem]"
      style={{ height: MAP_HEIGHT, border: `1px solid ${FIELD.line}`, background: "#eef2f6" }}
      data-testid="shift-map"
    >
      <img
        src={src}
        alt="Lot geofence map"
        className="h-full w-full object-cover"
        data-testid="shift-map-img"
      />
    </div>
  );
}

// Schematic fallback that mirrors the mockup's grid map.
function SchematicMap({ inside }: { inside: boolean }) {
  return (
    <div
      className="relative overflow-hidden rounded-[0.875rem]"
      style={{
        height: 188,
        border: `1px solid ${FIELD.line}`,
        background:
          "repeating-linear-gradient(0deg,#eef2f6 0 22px,#e6ecf2 22px 23px),repeating-linear-gradient(90deg,#eef2f6 0 22px,#e6ecf2 22px 23px)",
      }}
      data-testid="shift-map-schematic"
    >
      <div
        className="absolute"
        style={{ height: 13, left: 0, right: 0, top: 96, background: "#dde4ec" }}
      />
      <div
        className="absolute"
        style={{ width: 13, top: 0, bottom: 0, left: 150, background: "#dde4ec" }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: 128,
          height: 128,
          left: 96,
          top: 42,
          border: `2px dashed ${FIELD.accent}`,
          background: "rgba(31,111,235,.12)",
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: 13,
          height: 13,
          left: 153,
          top: 99,
          background: FIELD.header,
          border: "3px solid #fff",
          boxShadow: "0 1px 4px rgba(0,0,0,.3)",
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: 16,
          height: 16,
          left: inside ? 150 : 40,
          top: inside ? 92 : 150,
          background: inside ? FIELD.accent : "#c0392b",
          border: "3px solid #fff",
          boxShadow: inside
            ? "0 0 0 4px rgba(31,111,235,.25),0 1px 4px rgba(0,0,0,.3)"
            : "0 0 0 4px rgba(192,57,43,.22),0 1px 4px rgba(0,0,0,.3)",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// State 1 + 2: Pre-shift (outside = blocked / inside = ready).
// ---------------------------------------------------------------------------
function PreShiftState({
  geofence,
  geofenceLoading,
  geofenceError,
  position,
  distance,
  inside,
  geoError,
  geoPending,
  onRetryLocation,
  onCheckIn,
  checkingIn,
  onDirections,
}: {
  geofence: GeofenceInfo | null;
  geofenceLoading: boolean;
  geofenceError: string | null;
  position: GeoPosition | null;
  distance: number | null;
  inside: boolean;
  geoError: string | null;
  geoPending: boolean;
  onRetryLocation: () => void;
  onCheckIn: () => void;
  checkingIn: boolean;
  onDirections: () => void;
}) {
  if (geofenceLoading) {
    return <MapSkeleton label="Locating your lot…" />;
  }
  if (geofenceError) {
    return (
      <Banner
        kind="blocked"
        icon={<AlertTriangle className="h-5 w-5" />}
        title="Lot location unavailable"
        body={geofenceError}
      />
    );
  }
  if (!geofence) {
    return (
      <Banner
        kind="blocked"
        icon={<AlertTriangle className="h-5 w-5" />}
        title="No lot assigned"
        body="You have no assigned lot yet. Ask your admin to assign you to one."
      />
    );
  }

  const haveFix = position != null && distance != null;
  const lotShort = geofence.locationName;

  return (
    <>
      <ShiftMap
        locationId={geofence.locationId}
        center={geofence.center}
        radiusMeters={geofence.radiusMeters}
        user={position ? { lat: position.lat, lng: position.lng } : null}
        inside={inside}
      />

      {/* Status banner */}
      {!haveFix ? (
        <Banner
          kind="active"
          icon={
            geoPending ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Crosshair className="h-5 w-5" />
            )
          }
          title={geoPending ? "Getting your location…" : "Location needed"}
          body={
            geoError ??
            "We need your location to verify you're inside the lot before you can check in."
          }
        />
      ) : inside ? (
        <Banner
          kind="ready"
          icon={<Check className="h-5 w-5" />}
          title="You're inside the lot boundary"
          body="Location verified. You're cleared to start your shift."
        />
      ) : (
        <Banner
          kind="blocked"
          icon={<AlertTriangle className="h-5 w-5" />}
          title={`You're ${distanceLabel(distance!)} outside the lot`}
          body="Check-in is locked until you're within the lot boundary. Head to your assigned location to clock in."
        />
      )}

      {/* Info card */}
      <InfoCard
        rows={[
          {
            icon: <MapPin className="h-4 w-4" />,
            k: "Assigned lot",
            v: lotShort,
            text: true,
          },
          {
            icon: <Crosshair className="h-4 w-4" />,
            k: "Your distance",
            v: haveFix ? distanceLabel(distance!) : "—",
            color: haveFix && !inside ? "#c0392b" : undefined,
          },
          {
            icon: <Clock className="h-4 w-4" />,
            k: "Geofence radius",
            v: `${Math.round(geofence.radiusMeters)} m`,
          },
        ]}
      />

      {/* CTA */}
      {!haveFix ? (
        <CtaButton
          variant="ready"
          disabled={geoPending}
          onClick={onRetryLocation}
          icon={
            geoPending ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Crosshair className="h-5 w-5" />
            )
          }
          label={geoPending ? "Locating…" : "Enable location"}
        />
      ) : inside ? (
        <>
          <CtaButton
            variant="go"
            disabled={checkingIn}
            onClick={onCheckIn}
            icon={
              checkingIn ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Play className="h-5 w-5" />
              )
            }
            label={checkingIn ? "Checking in…" : "Check In to Shift"}
          />
          <SmsNote text="On check-in, an SMS confirms your shift start to the assigned enforcer & admin." />
        </>
      ) : (
        <>
          <CtaButton
            variant="disabled"
            disabled
            icon={<Play className="h-5 w-5" />}
            label="Check In — Locked"
          />
          <button
            type="button"
            onClick={onDirections}
            className="flex items-center justify-center gap-1.5 text-[12px] font-semibold"
            style={{ color: FIELD.accent }}
            data-testid="button-shift-directions"
          >
            <Navigation className="h-[13px] w-[13px]" /> Get directions to the lot
          </button>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// State 3: Active shift (live timer + check-out).
// ---------------------------------------------------------------------------
function ActiveState({
  shift,
  now,
  onCheckOut,
  checkingOut,
}: {
  shift: Shift;
  now: number;
  onCheckOut: () => void;
  checkingOut: boolean;
}) {
  return (
    <>
      {/* Big timer */}
      <div
        className="rounded-[0.875rem] px-4 py-5 text-center text-white"
        style={{ background: "linear-gradient(160deg,#0f2742,#193a60)" }}
        data-testid="shift-timer"
      >
        <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/60">
          Shift duration
        </div>
        <div
          className="mt-1 text-[42px] font-extrabold leading-none tracking-[-0.01em]"
          style={{ fontFamily: FIELD_MONO }}
          data-testid="text-shift-elapsed"
        >
          {elapsedLabel(shift.checkInAt, now)}
        </div>
        <div className="mt-2 flex items-center justify-center gap-1.5 text-[12px] text-white/70">
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{
              background: FIELD.ledOn,
              boxShadow: "0 0 0 3px rgba(63,207,134,.25)",
            }}
          />
          Started {timeLabel(shift.checkInAt)} · in geofence
        </div>
      </div>

      <InfoCard
        rows={[
          {
            icon: <Calendar className="h-4 w-4" />,
            k: "Started",
            v: timeLabel(shift.checkInAt),
          },
          {
            icon: <MapPin className="h-4 w-4" />,
            k: "Location lock",
            v: shift.geofenceVerified ? "Verified ✓" : "Unverified",
            text: true,
            color: shift.geofenceVerified ? "#1f7a44" : "#c0392b",
          },
        ]}
      />

      <Banner
        kind="active"
        icon={<Crosshair className="h-5 w-5" />}
        title="Time syncs to admin"
        body="Your hours appear live in the admin time-management view."
        compact
      />

      <CtaButton
        variant="out"
        disabled={checkingOut}
        onClick={onCheckOut}
        icon={
          checkingOut ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Square className="h-5 w-5" />
          )
        }
        label={checkingOut ? "Checking out…" : "Check Out of Shift"}
      />
      <SmsNote text="Check-out sends a shift-end SMS with your totals to admin & enforcer." />
    </>
  );
}

// ---------------------------------------------------------------------------
// State 4: Checked-out summary.
// ---------------------------------------------------------------------------
function SummaryState({
  shift,
  onBackToDash,
}: {
  shift: Shift;
  onBackToDash: () => void;
}) {
  const dateLabel = (() => {
    try {
      return format(parseISO(shift.checkInAt), "EEE · MMM d");
    } catch {
      return "—";
    }
  })();
  const total =
    shift.checkOutAt != null
      ? durationLabel(shift.checkInAt, shift.checkOutAt)
      : "—";

  return (
    <>
      <div className="pb-0.5 pt-1.5 text-center">
        <div
          className="mx-auto mb-2.5 flex h-[54px] w-[54px] items-center justify-center rounded-full"
          style={{ background: "#e4f4ea", border: "1px solid #bfe3cd" }}
        >
          <CheckCircle2 className="h-7 w-7" style={{ color: "#1f7a44" }} />
        </div>
        <h3 className="text-[18px] font-extrabold" data-testid="text-summary-title">
          Shift checked out
        </h3>
        <p className="mt-0.5 text-[12.5px]" style={{ color: FIELD.ink2 }}>
          Nice work — your hours have been logged to admin.
        </p>
      </div>

      <InfoCard
        rows={[
          { icon: <Calendar className="h-4 w-4" />, k: "Date", v: dateLabel, text: true },
          { icon: <Play className="h-4 w-4" />, k: "Checked in", v: timeLabel(shift.checkInAt) },
          {
            icon: <Square className="h-4 w-4" />,
            k: "Checked out",
            v: timeLabel(shift.checkOutAt),
          },
          {
            icon: <Clock className="h-4 w-4" />,
            k: "Total time",
            v: total,
            color: FIELD.accentInk,
          },
        ]}
      />

      <SmsNote text="Shift-end SMS sent to admin & enforcer with your total hours." />

      <CtaButton
        variant="accent"
        onClick={onBackToDash}
        icon={<CheckCircle2 className="h-5 w-5" />}
        label="Back to Dashboard"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared building blocks.
// ---------------------------------------------------------------------------
function NoLot() {
  return (
    <Banner
      kind="blocked"
      icon={<AlertTriangle className="h-5 w-5" />}
      title="No lot assigned"
      body="You have no assigned lot yet. Ask your admin to assign you to a lot before starting a shift."
    />
  );
}

function MapSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-[0.875rem]"
      style={{ height: 188, border: `1px solid ${FIELD.line}`, background: FIELD.fieldBg }}
      data-testid="shift-map-skeleton"
    >
      <Loader2 className="h-5 w-5 animate-spin" style={{ color: FIELD.ink3 }} />
      <span className="text-[12.5px] font-medium" style={{ color: FIELD.ink3 }}>
        {label}
      </span>
    </div>
  );
}

function Banner({
  kind,
  icon,
  title,
  body,
  compact,
}: {
  kind: "blocked" | "ready" | "active";
  icon: React.ReactNode;
  title: string;
  body: string;
  compact?: boolean;
}) {
  const palette = {
    blocked: { bg: "#fdecea", border: "#f5c6c0", title: "#c0392b", body: "#a13226" },
    ready: { bg: "#e4f4ea", border: "#bfe3cd", title: "#1f7a44", body: FIELD.ink2 },
    active: { bg: FIELD.accentSoft, border: "#c3d8fb", title: FIELD.accentInk, body: FIELD.accentInk },
  }[kind];
  return (
    <div
      className="flex items-start gap-[11px] rounded-[0.875rem]"
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        padding: compact ? "11px 13px" : "13px 14px",
      }}
      data-testid={`shift-banner-${kind}`}
    >
      <span className="mt-px shrink-0" style={{ color: palette.title }}>
        {icon}
      </span>
      <div>
        <div
          className="font-bold"
          style={{ color: palette.title, fontSize: compact ? "12.5px" : "13.5px" }}
        >
          {title}
        </div>
        <div
          className="mt-0.5 leading-[1.45]"
          style={{
            color: palette.body,
            fontSize: compact ? "11.5px" : "12px",
            opacity: kind === "active" ? 0.85 : 1,
          }}
        >
          {body}
        </div>
      </div>
    </div>
  );
}

type InfoRow = {
  icon: React.ReactNode;
  k: string;
  v: string;
  text?: boolean; // use proportional font instead of mono
  color?: string;
};

function InfoCard({ rows }: { rows: InfoRow[] }) {
  return (
    <div
      className="overflow-hidden rounded-[0.875rem]"
      style={{ background: "#fff", border: `1px solid ${FIELD.line}` }}
      data-testid="shift-infocard"
    >
      {rows.map((r, i) => (
        <div
          key={r.k}
          className="flex items-center justify-between px-3.5 py-3 text-[13px]"
          style={{
            borderBottom: i === rows.length - 1 ? "none" : `1px solid ${FIELD.line}`,
          }}
        >
          <span
            className="flex items-center gap-2 font-medium"
            style={{ color: FIELD.ink2 }}
          >
            <span style={{ color: FIELD.ink3 }}>{r.icon}</span>
            {r.k}
          </span>
          <span
            className="font-semibold"
            style={{
              fontFamily: r.text ? FIELD_FONT : FIELD_MONO,
              fontSize: "13px",
              color: r.color ?? FIELD.ink,
            }}
          >
            {r.v}
          </span>
        </div>
      ))}
    </div>
  );
}

function CtaButton({
  variant,
  label,
  icon,
  onClick,
  disabled,
}: {
  variant: "go" | "out" | "disabled" | "ready" | "accent";
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const styles: Record<string, React.CSSProperties> = {
    go: { background: FIELD.orange, color: "#fff" },
    accent: { background: FIELD.accent, color: "#fff" },
    out: { background: "#fff", color: "#c0392b", border: "1.5px solid #f0b9b2" },
    ready: { background: FIELD.accent, color: "#fff" },
    disabled: {
      background: FIELD.fieldBg,
      color: FIELD.ink3,
      border: `1px solid ${FIELD.line}`,
      cursor: "not-allowed",
    },
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-center gap-[9px] rounded-[0.875rem] py-4 text-[15px] font-bold disabled:opacity-100"
      style={{ ...styles[variant], opacity: disabled && variant !== "disabled" ? 0.7 : 1 }}
      data-testid={`button-shift-cta-${variant}`}
    >
      {icon}
      {label}
    </button>
  );
}

function SmsNote({ text }: { text: string }) {
  return (
    <div
      className="-mt-1 flex items-center gap-2 rounded-[0.625rem] px-[11px] py-[9px] text-[11.5px]"
      style={{
        color: FIELD.ink2,
        background: FIELD.fieldBg,
        border: `1px dashed ${FIELD.line}`,
      }}
      data-testid="shift-sms-note"
    >
      <MessageSquare className="h-[15px] w-[15px] shrink-0" style={{ color: FIELD.accent }} />
      {text}
    </div>
  );
}
