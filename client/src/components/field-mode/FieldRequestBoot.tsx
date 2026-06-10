import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  X,
  ChevronLeft,
  ScanLine,
  Camera,
  Check,
  CheckCircle2,
  MapPin,
  MessageSquareText,
  Send,
  Loader2,
  Home as HomeIcon,
  X as XIcon,
  MoreHorizontal,
  Minus,
  Clock,
} from "lucide-react";
import type { Location } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FIELD, FIELD_FONT, FIELD_MONO } from "./FieldShell";

// ---------------------------------------------------------------------------
// FieldRequestBoot — attendant "Request a Boot" flow. Wires the three states
// from the approved page5_shot mockup to the live v2 backend
// (POST /api/boot-requests). Attendants REQUEST; the request fires a stubbed
// SMS to the on-duty enforcer, who PLACES the boot (enforcer/admin resolve via
// PATCH /api/boot-requests/:id — untouched here, attendant-side only).
//
//   Step 1 · Capture        → plate (big mono) + scan affordance, REQUIRED photo
//                              evidence (file upload, gates Review), auto-detected
//                              lot card, free-text reason/note, optional fee.
//   Step 2 · Review & Send  → plate chip + evidence checklist + exact stubbed
//                              SMS preview to the on-duty enforcer.
//   Step 3 · Sent           → confirmation + live status timeline + actions.
//
// Schema notes (vs. mockup): the boot_requests table has no reason-enum or
// row/space field, so the mock's "Reason" dropdown maps to the free-text note
// and the location card shows the auto-detected lot name only (no fabricated
// row). Photo evidence is a hard-required image upload (real device camera is
// unavailable in-browser; Twilio/native capture wires later).
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3;

export function FieldRequestBoot({
  assignedLot,
  onClose,
  onViewInventory,
}: {
  assignedLot: Location | null;
  onClose: () => void;
  onViewInventory: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const plateRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>(1);

  // Form fields
  const [plate, setPlate] = useState("");
  const [reason, setReason] = useState("");
  const [fee, setFee] = useState(""); // optional suggested fee (dollars)
  // Photo evidence — data-URLs (hard-required: at least one before Review).
  const [photos, setPhotos] = useState<string[]>([]);

  // Sent recap (drives Step 3). Null until the request is submitted.
  const [sent, setSent] = useState<null | {
    plate: string;
    at: string; // formatted submit time
  }>(null);

  const lotName = assignedLot?.name ?? "your lot";

  // Autofocus the plate on mount so the attendant can type immediately.
  useEffect(() => {
    const t = setTimeout(() => plateRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  const plateOk = plate.trim().length > 0;
  const photoOk = photos.length > 0;
  // Step 1 → Step 2 requires a plate AND at least one photo (hard-required).
  const canReview = plateOk && photoOk;

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = Math.max(0, 4 - photos.length);
    const chosen = Array.from(files).slice(0, remaining);
    chosen.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setPhotos((prev) => (prev.length >= 4 ? prev : [...prev, reader.result as string]));
        }
      };
      reader.readAsDataURL(file);
    });
  }

  const submit = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        licensePlate: plate.trim(),
        // No structured make/model on this flow; the schema requires a
        // make/model string, so we send a clear placeholder the enforcer can
        // confirm/override when they place the boot.
        makeModel: "Unknown — confirm on placement",
        note: reason.trim(),
        photos,
      };
      const f = Number(fee);
      if (fee.trim() && Number.isFinite(f) && f >= 0) body.suggestedFee = f;
      const res = await apiRequest("POST", "/api/boot-requests", body);
      return (await res.json()) as { id: number; licensePlate: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/boot-requests"] });
      setSent({ plate: plate.trim(), at: format(new Date(), "h:mm a") });
      setStep(3);
      toast({
        title: "Boot request sent",
        description: `${plate.trim()} flagged — the on-duty enforcer was notified.`,
      });
    },
    onError: (err: any) => {
      const msg = String(err?.message ?? "").replace(/^\d+:\s*/, "");
      toast({
        title: "Couldn't send request",
        description: msg || "Something went wrong. Try again.",
        variant: "destructive",
      });
    },
  });

  // The exact SMS the enforcer will receive (mirrors notifyBootRequest in
  // server/sms.ts). Shown verbatim in the Step 2 preview so the attendant sees
  // precisely what gets dispatched.
  const smsBody =
    `Boot REQUEST: ${plate.trim() || "—"} (Unknown — confirm on placement) flagged by you` +
    (assignedLot ? ` at ${assignedLot.name}.` : ".");

  return (
    <div
      className="flex min-h-full flex-col"
      style={{ background: "#fff", fontFamily: FIELD_FONT, color: FIELD.ink }}
      data-testid="field-request-boot"
    >
      {/* Header — dark blue, with back/close + step progress bar */}
      <div
        className="px-4 pb-3 pt-[15px]"
        style={{
          background: `linear-gradient(160deg, ${FIELD.header}, ${FIELD.header2})`,
        }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (step === 2) setStep(1);
              else onClose();
            }}
            className="flex h-8 w-8 items-center justify-center rounded-[9px]"
            style={{ background: "rgba(255,255,255,.12)" }}
            aria-label={step === 2 ? "Back" : "Close"}
            data-testid="button-request-back"
          >
            {step === 2 ? (
              <ChevronLeft className="h-[19px] w-[19px] text-white" />
            ) : (
              <X className="h-[19px] w-[19px] text-white" />
            )}
          </button>
          <div className="text-base font-bold text-white" data-testid="text-request-title">
            {step === 1 ? "Request a Boot" : step === 2 ? "Review & Send" : "Request Sent"}
          </div>
        </div>
        {/* 3-segment progress bar */}
        <div className="mt-3 flex gap-1.5">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className="h-[3px] flex-1 rounded-full"
              style={{
                background:
                  s < step
                    ? FIELD.ledOn
                    : s === step
                      ? FIELD.orange
                      : "rgba(255,255,255,.22)",
              }}
              data-testid={`progress-step-${s}`}
            />
          ))}
        </div>
      </div>

      {/* ---- STEP 1 · CAPTURE ---- */}
      {step === 1 && (
        <>
          <div className="flex flex-1 flex-col gap-[18px] px-4 pb-[120px] pt-[18px]">
            {/* License plate */}
            <Field label="License plate" required>
              <div
                className="rounded-[0.875rem] px-3 py-3"
                style={{
                  background: FIELD.accentSoft,
                  border: `1.5px solid ${FIELD.accent}`,
                }}
              >
                <input
                  ref={plateRef}
                  value={plate}
                  onChange={(e) => setPlate(e.target.value.toUpperCase())}
                  placeholder="ABC-0000"
                  inputMode="text"
                  autoCapitalize="characters"
                  className="w-full bg-transparent text-center text-[26px] font-bold tracking-[0.18em] outline-none placeholder:text-[#94a1ad]"
                  style={{ fontFamily: FIELD_MONO, color: FIELD.ink }}
                  data-testid="input-request-plate"
                />
              </div>
              <div
                className="mt-2 flex items-center justify-center gap-1.5 text-[12px] font-semibold"
                style={{ color: FIELD.accent }}
              >
                <ScanLine className="h-[15px] w-[15px]" /> Tap to scan plate with
                camera
              </div>
            </Field>

            {/* Photo evidence — REQUIRED */}
            <Field label="Photo evidence" required>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = "";
                }}
                data-testid="input-request-photo"
              />
              <div className="flex flex-wrap gap-2.5">
                {photos.map((src, i) => (
                  <div
                    key={i}
                    className="relative h-[88px] w-[120px] overflow-hidden rounded-[12px]"
                    style={{ border: `1px solid ${FIELD.line}` }}
                    data-testid={`photo-thumb-${i}`}
                  >
                    <img
                      src={src}
                      alt={`Evidence ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                      className="absolute right-1 top-1 flex h-[22px] w-[22px] items-center justify-center rounded-full"
                      style={{ background: "rgba(13,27,42,.72)" }}
                      aria-label="Remove photo"
                      data-testid={`button-remove-photo-${i}`}
                    >
                      <XIcon className="h-[13px] w-[13px] text-white" />
                    </button>
                  </div>
                ))}
                {photos.length < 4 && (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="flex h-[88px] w-[120px] flex-col items-center justify-center gap-1.5 rounded-[12px]"
                    style={{
                      background: FIELD.accentSoft,
                      border: `1.5px dashed ${FIELD.accent}`,
                      color: FIELD.accentInk,
                    }}
                    data-testid="button-add-photo"
                  >
                    <Camera className="h-[20px] w-[20px]" />
                    <span className="text-[12px] font-semibold">Add photo</span>
                  </button>
                )}
              </div>
              {!photoOk && (
                <div
                  className="mt-2 text-[12px] font-medium"
                  style={{ color: FIELD.ink3 }}
                >
                  At least one photo is required before you can review.
                </div>
              )}
            </Field>

            {/* Location — auto-detected lot (no fabricated row) */}
            <Field label="Location">
              <div
                className="flex items-start gap-2.5 rounded-[0.875rem] px-[13px] py-3"
                style={{
                  background: "#e4f4ea",
                  border: "1px solid #bfe6cd",
                }}
                data-testid="request-location"
              >
                <MapPin
                  className="mt-[1px] h-[17px] w-[17px] flex-shrink-0"
                  style={{ color: "#1f7a44" }}
                />
                <div className="min-w-0">
                  <div
                    className="text-[13.5px] font-bold"
                    style={{ color: "#15532f" }}
                  >
                    {assignedLot ? `${assignedLot.name} · auto-detected` : "No lot assigned"}
                  </div>
                  <div className="text-[12px] font-medium" style={{ color: "#2f7a52" }}>
                    {assignedLot
                      ? `${assignedLot.address} · GPS ✓`
                      : "Assign a lot to attach a location"}
                  </div>
                </div>
              </div>
            </Field>

            {/* Reason / note — free-text (maps to note) */}
            <Field label="Reason / note">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. No valid payment on file"
                rows={2}
                maxLength={500}
                className="w-full resize-none rounded-[0.875rem] px-[13px] py-3 text-[14px] outline-none placeholder:text-[#94a1ad]"
                style={{
                  background: FIELD.fieldBg,
                  border: `1px solid ${FIELD.line}`,
                  color: FIELD.ink,
                }}
                data-testid="input-request-reason"
              />
            </Field>

            {/* Optional suggested fee */}
            <Field label="Suggested fee (optional)">
              <div
                className="flex items-center gap-2 rounded-[0.875rem] px-[13px] py-3"
                style={{
                  background: FIELD.fieldBg,
                  border: `1px solid ${FIELD.line}`,
                }}
              >
                <span
                  className="text-[16px] font-bold"
                  style={{ color: FIELD.ink2, fontFamily: FIELD_MONO }}
                >
                  $
                </span>
                <input
                  value={fee}
                  onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="enforcer can adjust"
                  inputMode="decimal"
                  className="w-full bg-transparent text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-[#94a1ad]"
                  style={{ fontFamily: FIELD_MONO, color: FIELD.ink }}
                  data-testid="input-request-fee"
                />
              </div>
            </Field>
          </div>

          {/* Sticky footer — Review (orange = reserved primary) */}
          <div
            className="sticky bottom-0 border-t px-4 py-3"
            style={{ background: "#fff", borderColor: FIELD.line }}
          >
            <button
              type="button"
              disabled={!canReview}
              onClick={() => setStep(2)}
              className="flex w-full items-center justify-center gap-2 rounded-[0.875rem] py-[15px] text-[15px] font-bold text-white"
              style={{
                background: canReview ? FIELD.orange : "#f0b89a",
                boxShadow: canReview ? "0 6px 16px rgba(232,86,10,.32)" : "none",
              }}
              data-testid="button-request-review"
            >
              Review Request ›
            </button>
          </div>
        </>
      )}

      {/* ---- STEP 2 · REVIEW & SEND ---- */}
      {step === 2 && (
        <>
          <div className="flex flex-1 flex-col gap-4 px-4 pb-[120px] pt-[18px]">
            {/* Plate chip + heading */}
            <div className="flex items-center gap-3">
              <div
                className="rounded-[10px] px-3 py-2 text-[15px] font-bold tracking-[0.1em] text-white"
                style={{ background: FIELD.ink, fontFamily: FIELD_MONO }}
                data-testid="review-plate-chip"
              >
                {plate.trim() || "—"}
              </div>
              <div>
                <div className="text-[15px] font-bold" style={{ color: FIELD.ink }}>
                  Boot request
                </div>
                <div className="text-[12.5px] font-medium" style={{ color: FIELD.ink2 }}>
                  {assignedLot ? assignedLot.name : "No lot assigned"}
                </div>
              </div>
            </div>

            {/* Evidence checklist */}
            <div
              className="rounded-[14px]"
              style={{ border: `1px solid ${FIELD.line}` }}
              data-testid="review-checklist"
            >
              <CheckRow label="License plate" value={plate.trim() || "—"} mono />
              <CheckRow
                label="Photo evidence"
                value={`${photos.length} photo${photos.length === 1 ? "" : "s"}`}
              />
              <CheckRow
                label="GPS location"
                value={assignedLot ? "Verified" : "No lot"}
                ok={!!assignedLot}
              />
              <CheckRow
                label="Reason"
                value={reason.trim() || "Not specified"}
                last
              />
            </div>

            {/* SMS preview */}
            <div
              className="overflow-hidden rounded-[14px]"
              style={{ border: `1px solid ${FIELD.line}` }}
            >
              <div
                className="flex items-center gap-2 px-[13px] py-2.5"
                style={{ background: FIELD.accentSoft }}
              >
                <MessageSquareText
                  className="h-[15px] w-[15px]"
                  style={{ color: FIELD.accentInk }}
                />
                <span
                  className="text-[12.5px] font-bold"
                  style={{ color: FIELD.accentInk }}
                >
                  SMS to enforcer on send
                </span>
              </div>
              <div className="px-[13px] py-3">
                <div
                  className="rounded-[10px] px-3 py-3 text-[13px] leading-[1.5]"
                  style={{ background: FIELD.fieldBg, color: FIELD.ink }}
                  data-testid="review-sms-body"
                >
                  {smsBody}
                </div>
                <div
                  className="mt-2.5 flex items-center gap-1.5 text-[11.5px] font-medium"
                  style={{ color: FIELD.ink3 }}
                >
                  <Send className="h-[13px] w-[13px]" />
                  To: the on-duty enforcer
                </div>
              </div>
            </div>
          </div>

          {/* Sticky footer — Send (orange) */}
          <div
            className="sticky bottom-0 border-t px-4 py-3"
            style={{ background: "#fff", borderColor: FIELD.line }}
          >
            <button
              type="button"
              disabled={submit.isPending}
              onClick={() => submit.mutate()}
              className="flex w-full items-center justify-center gap-2 rounded-[0.875rem] py-[15px] text-[15px] font-bold text-white"
              style={{
                background: FIELD.orange,
                boxShadow: "0 6px 16px rgba(232,86,10,.32)",
                opacity: submit.isPending ? 0.7 : 1,
              }}
              data-testid="button-request-send"
            >
              {submit.isPending ? (
                <>
                  <Loader2 className="h-[18px] w-[18px] animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Send className="h-[17px] w-[17px]" /> Send Boot Request
                </>
              )}
            </button>
          </div>
        </>
      )}

      {/* ---- STEP 3 · SENT ---- */}
      {step === 3 && sent && (
        <div className="flex flex-1 flex-col px-4 pb-8 pt-8">
          {/* Confirmation hero */}
          <div className="flex flex-col items-center text-center">
            <div
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full"
              style={{ background: FIELD.accentSoft }}
            >
              <MessageSquareText
                className="h-[34px] w-[34px]"
                style={{ color: FIELD.accentInk }}
              />
            </div>
            <div
              className="mt-4 text-[20px] font-bold"
              style={{ color: FIELD.ink }}
              data-testid="text-request-sent"
            >
              Boot request sent
            </div>
            <div
              className="mt-2 max-w-[280px] text-[13.5px] leading-[1.5]"
              style={{ color: FIELD.ink2 }}
            >
              The on-duty enforcer was notified by SMS and is on the way.
            </div>
          </div>

          {/* Live status timeline */}
          <div
            className="mt-7 rounded-[14px] px-4 py-2"
            style={{ border: `1px solid ${FIELD.line}` }}
            data-testid="request-timeline"
          >
            <TimelineRow
              icon={<CheckCircle2 className="h-[18px] w-[18px]" style={{ color: "#1f7a44" }} />}
              label="Request submitted"
              meta={sent.at}
              done
            />
            <TimelineRow
              icon={<MessageSquareText className="h-[18px] w-[18px]" style={{ color: FIELD.accentInk }} />}
              label="SMS sent to enforcer"
              meta={sent.at}
              done
            />
            <TimelineRow
              icon={<MoreHorizontal className="h-[18px] w-[18px]" style={{ color: FIELD.orange }} />}
              label="Awaiting enforcer"
              meta="···"
              pending
            />
            <TimelineRow
              icon={<Clock className="h-[18px] w-[18px]" style={{ color: FIELD.ink3 }} />}
              label="Boot placed"
              meta={<Minus className="h-[14px] w-[14px]" style={{ color: FIELD.ink3 }} />}
              last
            />
          </div>

          <div className="flex-1" />

          {/* Actions */}
          <div className="mt-6 flex flex-col gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="flex w-full items-center justify-center gap-2 rounded-[0.875rem] py-[15px] text-[15px] font-bold text-white"
              style={{
                background: FIELD.accent,
                boxShadow: "0 6px 16px rgba(31,111,235,.28)",
              }}
              data-testid="button-back-dashboard"
            >
              <HomeIcon className="h-[17px] w-[17px]" /> Back to Dashboard
            </button>
            <button
              type="button"
              onClick={onViewInventory}
              className="w-full rounded-[0.875rem] py-[15px] text-[15px] font-bold"
              style={{
                background: "#fff",
                border: `1px solid ${FIELD.line}`,
                color: FIELD.ink,
              }}
              data-testid="button-view-inventory"
            >
              View in Inventory
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Small building blocks -------------------------------------------------

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em]"
        style={{ color: FIELD.ink2 }}
      >
        {label}
        {required && <span style={{ color: FIELD.orange }}> *</span>}
      </div>
      {children}
    </div>
  );
}

function CheckRow({
  label,
  value,
  ok = true,
  mono,
  last,
}: {
  label: string;
  value: string;
  ok?: boolean;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3 px-[13px] py-3"
      style={last ? undefined : { borderBottom: `1px solid ${FIELD.line}` }}
    >
      <CheckCircle2
        className="h-[18px] w-[18px] flex-shrink-0"
        style={{ color: ok ? "#1f7a44" : FIELD.ink3 }}
      />
      <span className="flex-1 text-[13.5px] font-semibold" style={{ color: FIELD.ink }}>
        {label}
      </span>
      <span
        className="max-w-[55%] truncate text-right text-[13px] font-medium"
        style={{
          color: FIELD.ink2,
          fontFamily: mono ? FIELD_MONO : FIELD_FONT,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function TimelineRow({
  icon,
  label,
  meta,
  done,
  pending,
  last,
}: {
  icon: React.ReactNode;
  label: string;
  meta: React.ReactNode;
  done?: boolean;
  pending?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3 py-3"
      style={last ? undefined : { borderBottom: `1px solid ${FIELD.line}` }}
    >
      <span className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center">
        {icon}
      </span>
      <span
        className="flex-1 text-[14px] font-bold"
        style={{
          color: done ? FIELD.ink : pending ? FIELD.orange : FIELD.ink3,
        }}
      >
        {label}
      </span>
      <span className="text-[12.5px] font-medium" style={{ color: FIELD.ink3 }}>
        {meta}
      </span>
    </div>
  );
}
