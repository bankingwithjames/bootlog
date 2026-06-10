// ---------------------------------------------------------------------------
// SMS dispatch layer (STUBBED)
// ---------------------------------------------------------------------------
// A single seam for every outbound SMS the app sends. Right now it only logs
// the message (no real send) so the field-mode flows can be exercised end to
// end without a provider. When the real provider (Twilio) is wired, only the
// `send` implementation in this file changes — every call site stays the same.
//
// The four triggers (all attendant-initiated notifications to enforcer/admin):
//   1. boot-request    — attendant flags a vehicle for booting
//   2. release-request — attendant asks an enforcer to remove a boot
//   3. shift-check-in  — attendant starts a geofenced shift
//   4. shift-check-out — attendant ends a shift
// ---------------------------------------------------------------------------

export type SmsTrigger =
  | "boot-request"
  | "release-request"
  | "shift-check-in"
  | "shift-check-out";

export interface SmsMessage {
  trigger: SmsTrigger;
  // The intended recipient role(s). The real provider will resolve these to
  // phone numbers; the stub just records them.
  to: Array<"enforcer" | "admin">;
  // Human-readable body that would be texted.
  body: string;
  // Free-form structured context for logging / future templating.
  meta?: Record<string, unknown>;
}

// Whether a real provider is active. Always false while stubbed; flips to true
// once Twilio (or similar) credentials + client are wired into `send` below.
export const SMS_ENABLED = false;

// The one place a message actually goes out. STUB: log only, never send.
async function send(msg: SmsMessage): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `[sms:STUB] trigger=${msg.trigger} to=${msg.to.join(",")} :: ${msg.body}` +
      (msg.meta ? ` :: ${JSON.stringify(msg.meta)}` : ""),
  );
}

// Fire-and-forget dispatch. Never throws into the request path — an SMS
// failure must not roll back the underlying action (a placed boot, an opened
// shift). Errors are swallowed + logged.
export function dispatchSms(msg: SmsMessage): void {
  void send(msg).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[sms] dispatch failed (trigger=${msg.trigger})`, err);
  });
}

// ---- Typed convenience builders for each trigger ----

export function notifyBootRequest(args: {
  plate: string;
  makeModel: string;
  byName: string;
  locationName?: string;
}): void {
  dispatchSms({
    trigger: "boot-request",
    to: ["enforcer"],
    body:
      `Boot REQUEST: ${args.plate} (${args.makeModel}) flagged by ${args.byName}` +
      (args.locationName ? ` at ${args.locationName}.` : "."),
    meta: args,
  });
}

export function notifyReleaseRequest(args: {
  plate: string;
  makeModel: string;
  byName: string;
  bootId: number;
  locationName?: string;
}): void {
  dispatchSms({
    trigger: "release-request",
    to: ["enforcer"],
    body:
      `RELEASE request: ${args.plate} (${args.makeModel}) — ${args.byName} requests boot removal` +
      (args.locationName ? ` at ${args.locationName}.` : "."),
    meta: args,
  });
}

export function notifyShiftCheckIn(args: {
  byName: string;
  locationName: string;
  at: string;
}): void {
  dispatchSms({
    trigger: "shift-check-in",
    to: ["enforcer", "admin"],
    body: `${args.byName} CHECKED IN at ${args.locationName}.`,
    meta: args,
  });
}

export function notifyShiftCheckOut(args: {
  byName: string;
  locationName: string;
  at: string;
  durationLabel?: string;
}): void {
  dispatchSms({
    trigger: "shift-check-out",
    to: ["enforcer", "admin"],
    body:
      `${args.byName} CHECKED OUT of ${args.locationName}` +
      (args.durationLabel ? ` after ${args.durationLabel}.` : "."),
    meta: args,
  });
}
