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

// Fetch all paid sessions created within [startUnix, endUnix). Paginates.
export async function fetchPaidCars(
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

// Normalize a plate for matching: uppercase, strip spaces/dashes.
export function normalizePlate(plate: string): string {
  return (plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
