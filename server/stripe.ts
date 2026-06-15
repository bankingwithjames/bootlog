// Reads paid Checkout Sessions from Stripe and normalizes car details.
//
// Auth — three supported paths, preferred first:
//
// 1. Direct secret key (STANDALONE HOSTS, e.g. Vercel). When STRIPE_SECRET_KEY
//    is set (an sk_live_/rk_live_ value), we call api.stripe.com directly with
//    `Authorization: Bearer <key>`. This is the correct path for any normal
//    public host (Vercel, etc.) that can reach Stripe directly and where the
//    Perplexity credential proxy / HTTPS_PROXY do NOT exist. The key value comes
//    only from the deployment's env var — never hard-coded in source.
//
// 2. Credential proxy (DURABLE — Perplexity sandbox / published pplx.app). When
//    the server is started with api_credentials=['custom-cred:api.stripe.com'],
//    the platform injects CUSTOM_CRED_API_STRIPE_COM_URL (a stable proxy
//    endpoint that stands in for https://api.stripe.com) and
//    CUSTOM_CRED_API_STRIPE_COM_TOKEN. We send the token as the `x-api-key`
//    header and the proxy injects the real Stripe Authorization before
//    forwarding. Stable for the life of the deployment.
//
// 3. HTTPS_PROXY fallback (LEGACY). Older path that routes plain requests to
//    api.stripe.com through the rotating inline proxy. Kept only as a fallback
//    for environments where neither STRIPE_SECRET_KEY nor the CUSTOM_CRED_* vars
//    are present. The inline proxy token expires, so this path can start
//    returning 407s after a while.
//
// Under paths 2 and 3 no Stripe key lives in code; under path 1 the key is
// supplied via env var only.
//
// Data quirk handled here: this account's Checkout custom-field KEYS are
// scrambled (key "makemodel" holds the color, key "color" holds the make/model),
// but the visible LABELS are correct. So we map by label, not by key.

export interface PaidCar {
  id: string;
  makeModel: string;
  color: string;
  licensePlate: string;
  paidAt: string; // ISO timestamp
  source?: "stripe" | "manual"; // origin of this row (defaults to stripe)
  // Manual-entry payment details (only present on manual rows).
  amount?: number | null; // dollars collected at the lot
  method?: "cash" | "card" | "app" | null; // how it was paid in the field
  space?: string | null; // parking space / row label
  // Parking-lot address parsed from a charge description (PocketVendor app
  // charges put the lot address in the description, e.g.
  // "1x 2615 Elm Street - Deep Ellum (All-Day Parking)"). Used to link the
  // payment to a locations row. Null/absent on Checkout-Session rows.
  lotAddress?: string | null;
}

import { ProxyAgent, request, type Dispatcher } from "undici";

// --- Path selection -------------------------------------------------------
// Priority: (1) direct STRIPE_SECRET_KEY, (2) durable credential proxy,
// (3) legacy HTTPS_PROXY.
const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
const useDirectKey = Boolean(secretKey);

const credUrl = (process.env.CUSTOM_CRED_API_STRIPE_COM_URL || "").replace(
  /\/+$/,
  "",
);
const credToken = process.env.CUSTOM_CRED_API_STRIPE_COM_TOKEN || "";
// Only use the credential proxy when a direct key is NOT provided.
const useCredProxy = !useDirectKey && Boolean(credUrl && credToken);

// Base path for the Stripe REST API. Under the credential proxy the host is the
// injected proxy URL; otherwise we hit api.stripe.com directly.
const STRIPE_BASE = useCredProxy
  ? `${credUrl}/v1`
  : "https://api.stripe.com/v1";

// HTTPS_PROXY fallback dispatcher (only used when neither the direct key nor
// the credential proxy is configured).
let dispatcher: Dispatcher | undefined;
if (!useDirectKey && !useCredProxy) {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (proxyUrl) {
    dispatcher = new ProxyAgent(proxyUrl);
  }
}

async function stripeGet(
  url: string,
): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Direct key: standard Stripe Bearer auth straight to api.stripe.com.
  if (useDirectKey) headers["Authorization"] = `Bearer ${secretKey}`;
  // Credential proxy expects the token as x-api-key; it adds the real auth.
  else if (useCredProxy) headers["x-api-key"] = credToken;

  const r = await request(url, {
    method: "GET",
    headers,
    dispatcher, // undefined under the credential proxy (direct connection)
  });
  return {
    ok: r.statusCode >= 200 && r.statusCode < 300,
    status: r.statusCode,
    text: () => r.body.text(),
  };
}

function fieldValue(f: any): string {
  switch (f?.type) {
    case "dropdown":
      return f.dropdown?.value ?? "";
    case "numeric":
      return f.numeric?.value ?? "";
    case "text":
    default:
      return f.text?.value ?? "";
  }
}

// Normalize a label like "Make Model" / "make_model" -> "makemodel"
function labelKey(label: string): string {
  return (label || "").toLowerCase().replace(/[^a-z]/g, "");
}

function mapSession(session: any): PaidCar {
  let makeModel = "";
  let color = "";
  let licensePlate = "";

  for (const f of session.custom_fields ?? []) {
    const lbl = labelKey(f?.label?.custom ?? "");
    const val = fieldValue(f);
    if (lbl === "makemodel") makeModel = val;
    else if (lbl === "color") color = val;
    else if (lbl === "licenseplate") licensePlate = val;
  }

  return {
    id: session.id,
    makeModel,
    color,
    licensePlate,
    paidAt: new Date((session.created ?? 0) * 1000).toISOString(),
  };
}

// Fetch all paid Checkout Sessions created within [startUnix, endUnix).
// Paginates. (Online checkout flow with custom plate/make/color fields.)
async function fetchPaidSessions(
  startUnix: number,
  endUnix: number,
): Promise<PaidCar[]> {
  const results: PaidCar[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("created[gte]", String(startUnix));
    params.set("created[lt]", String(endUnix));
    if (startingAfter) params.set("starting_after", startingAfter);

    const res = await stripeGet(`${STRIPE_BASE}/checkout/sessions?${params}`);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stripe ${res.status}: ${text.slice(0, 300)}`);
    }

    const body = JSON.parse(await res.text());
    const data: any[] = body.data ?? [];

    for (const s of data) {
      if (s.payment_status === "paid" || s.status === "complete") {
        results.push(mapSession(s));
      }
    }

    if (!body.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1]?.id;
  }

  return results;
}

// --- Charges (the path the field cashier + PocketVendor iOS app use) --------
//
// This account takes payments two ways that DON'T create Checkout Sessions:
//
//   A. PocketVendor iOS app charges (metadata.from_app ===
//      "com.pocketvendor.payment"). The license plate is the linked CUSTOMER's
//      name (e.g. customer cus_... name "PXZ3535"); the charge `description` is
//      the parking-lot address (e.g. "1x 2615 Elm Street - Deep Ellum
//      (All-Day Parking)"). We surface plate <- customer.name and link the
//      lot via `lotAddress` <- description.
//
//   B. Manual cashier charges (no from_app). Older manual entries put the plate
//      directly in the charge `description` (e.g. "XRG 3634"). We use the
//      description as the plate as-is. (Some recent manual charges have an
//      empty description and no plate anywhere reachable; those fall back to
//      the customer name if present, else are skipped — see mapCharge.)
//
// Charges read the linked customer's name to recover the plate, so the Stripe
// key needs Customers Read. If that permission is missing we degrade
// gracefully (plate falls back to the customer id) rather than throwing.

// Memoize customer-name lookups within a single fetch pass. We cache the
// in-flight promise (not just the resolved value) so concurrent mapCharge
// calls for the same customer share one network round-trip instead of firing
// duplicates — important now that charges are mapped in parallel.
const customerNameCache = new Map<string, Promise<string>>();
let customerReadDenied = false;

async function fetchCustomerName(customerId: string): Promise<string> {
  if (!customerId) return "";
  if (customerReadDenied) return "";
  const cached = customerNameCache.get(customerId);
  if (cached) return cached;

  const lookup = (async () => {
    const res = await stripeGet(`${STRIPE_BASE}/customers/${customerId}`);
    if (!res.ok) {
      // 403 => key lacks Customers Read. Stop retrying for this pass and
      // degrade gracefully; other statuses are treated as "no name".
      if (res.status === 403) customerReadDenied = true;
      return "";
    }
    const body = JSON.parse(await res.text());
    return (body?.name || body?.description || "").trim();
  })();

  customerNameCache.set(customerId, lookup);
  return lookup;
}

// Strip a leading quantity prefix like "1x " from an app description so the
// stored lot address matches the locations table more cleanly.
function cleanLotAddress(desc: string): string {
  return (desc || "").replace(/^\s*\d+\s*x\s*/i, "").trim();
}

// Map one Stripe Charge to a PaidCar, classified by origin. Returns null for
// charges we should not surface (unpaid/refunded, or app/manual rows with no
// recoverable plate).
async function mapCharge(charge: any): Promise<PaidCar | null> {
  // Only surface real, completed money.
  if (!charge?.paid || charge.status !== "succeeded" || charge.refunded)
    return null;

  const fromApp = charge.metadata?.from_app;
  const desc = (charge.description || "").trim();
  const paidAt = new Date((charge.created ?? 0) * 1000).toISOString();
  const amount =
    typeof charge.amount === "number" ? charge.amount / 100 : null;

  if (fromApp === "com.pocketvendor.payment") {
    // App charge: plate = customer name; description = lot address.
    const plate = await fetchCustomerName(charge.customer);
    if (!plate) return null; // no recoverable plate (e.g. Customers Read off)
    return {
      id: charge.id,
      makeModel: "",
      color: "",
      licensePlate: plate,
      paidAt,
      source: "stripe",
      amount,
      method: "app",
      space: null,
      lotAddress: cleanLotAddress(desc) || null,
    };
  }

  // Manual cashier charge (no from_app).
  // Prefer an explicit plate typed into the description; otherwise fall back
  // to the customer name if one is attached. Skip rows with neither (these are
  // bare charges with no identifying info).
  let plate = desc;
  if (!plate && charge.customer) plate = await fetchCustomerName(charge.customer);
  if (!plate) return null;
  return {
    id: charge.id,
    makeModel: "",
    color: "",
    licensePlate: plate,
    paidAt,
    source: "stripe",
    amount,
    method: "card",
    space: null,
    lotAddress: null,
  };
}

// Fetch all qualifying Charges created within [startUnix, endUnix). Paginates.
async function fetchPaidCharges(
  startUnix: number,
  endUnix: number,
): Promise<PaidCar[]> {
  const results: PaidCar[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("created[gte]", String(startUnix));
    params.set("created[lt]", String(endUnix));
    if (startingAfter) params.set("starting_after", startingAfter);

    const res = await stripeGet(`${STRIPE_BASE}/charges?${params}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stripe charges ${res.status}: ${text.slice(0, 300)}`);
    }

    const body = JSON.parse(await res.text());
    const data: any[] = body.data ?? [];

    // Map charges in parallel: each app charge may trigger a customer-name
    // lookup (a separate Stripe round-trip). Running them concurrently keeps
    // the whole pass well under the published-sandbox request timeout instead
    // of serializing 10+ network calls.
    const mappedAll = await Promise.all(data.map((c) => mapCharge(c)));
    for (const mapped of mappedAll) {
      if (mapped) results.push(mapped);
    }

    if (!body.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1]?.id;
  }

  return results;
}

// Fetch all paid cars created within [startUnix, endUnix) from BOTH Stripe
// surfaces — Checkout Sessions and Charges — and merge them. De-dupes by
// charge/session id (a Checkout Session and its underlying charge can both
// appear; we keep the Checkout-Session row when plates collide because it
// carries make/model/color). Paginates within each source.
export async function fetchPaidCars(
  startUnix: number,
  endUnix: number,
): Promise<PaidCar[]> {
  // Reset the per-pass customer cache so a key-permission change is picked up.
  customerNameCache.clear();
  customerReadDenied = false;

  const [sessions, charges] = await Promise.all([
    fetchPaidSessions(startUnix, endUnix),
    fetchPaidCharges(startUnix, endUnix),
  ]);

  // De-dupe by normalized plate: a Checkout Session row (rich make/model/color)
  // wins over a Charge row for the same plate. Charges with a unique plate (the
  // cashier + app payments we're surfacing) are added.
  const sessionPlates = new Set(
    sessions.map((c) => normalizePlate(c.licensePlate)).filter(Boolean),
  );
  const extraCharges = charges.filter(
    (c) => !sessionPlates.has(normalizePlate(c.licensePlate)),
  );

  const merged = [...sessions, ...extraCharges];
  merged.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  return merged;
}

// Normalize a plate for matching: uppercase, strip spaces/dashes.
export function normalizePlate(plate: string): string {
  return (plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
