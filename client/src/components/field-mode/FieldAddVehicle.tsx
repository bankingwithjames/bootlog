import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  X,
  ScanLine,
  ChevronDown,
  Check,
  CheckCircle2,
  Search as SearchIcon,
  Plus,
  Lock,
  Banknote,
  CreditCard,
  QrCode,
  Loader2,
} from "lucide-react";
import type { Location } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FIELD, FIELD_FONT, FIELD_MONO } from "./FieldShell";

// ---------------------------------------------------------------------------
// FieldAddVehicle — attendant "Add Paid Vehicle" manual-entry flow. Wires the
// four states from the approved page3_add_vehicle.html mockup to the live v2
// backend (POST /api/paid-cars/manual):
//   1. Manual entry form  → plate, make/model, color chips, space/row, payment
//   2. Dropdown sheet      → searchable make/model picker + "add custom"
//   3. Financials gated    → payment AMOUNT field locked when admin hides it
//   4. Saved confirmation  → recap + "Add another" / "View inventory"
//
// Capture sequence (per spec): Plate → Make/Model → Space → Payment. The
// payment amount is only stored when financials are visible to staff; the
// server enforces this authoritatively (it drops the amount otherwise).
// ---------------------------------------------------------------------------

// Browser tz offset in minutes (matches home.tsx so the server bins the row to
// the attendant's local day).
const TZ_OFFSET = new Date().getTimezoneOffset();

type PayMethod = "cash" | "card" | "app";

// Common makes → models. Attendants can also type a custom make/model via the
// picker's "Add custom" affordance, so this is a convenience list, not a gate.
const MAKES: { make: string; models: string[] }[] = [
  { make: "Toyota", models: ["Camry", "Corolla", "RAV4", "Tacoma", "Highlander", "Tundra"] },
  { make: "Honda", models: ["Civic", "Accord", "CR-V", "Pilot", "Odyssey"] },
  { make: "Ford", models: ["F-150", "Escape", "Explorer", "Mustang", "Focus"] },
  { make: "Chevrolet", models: ["Silverado", "Equinox", "Malibu", "Tahoe", "Camaro"] },
  { make: "Nissan", models: ["Altima", "Sentra", "Rogue", "Maxima", "Frontier"] },
  { make: "Hyundai", models: ["Elantra", "Sonata", "Tucson", "Santa Fe"] },
  { make: "Kia", models: ["Optima", "Sorento", "Sportage", "Forte", "Soul"] },
  { make: "Jeep", models: ["Wrangler", "Grand Cherokee", "Cherokee", "Compass"] },
  { make: "GMC", models: ["Sierra", "Yukon", "Acadia", "Terrain"] },
  { make: "Dodge", models: ["Charger", "Challenger", "Durango", "Ram 1500"] },
  { make: "BMW", models: ["3 Series", "5 Series", "X3", "X5"] },
  { make: "Mercedes-Benz", models: ["C-Class", "E-Class", "GLC", "GLE"] },
  { make: "Tesla", models: ["Model 3", "Model Y", "Model S", "Model X"] },
];

// Color swatch chips (label + dot color). Match the mockup's first-row set.
const COLORS: { name: string; dot: string; ring?: boolean }[] = [
  { name: "White", dot: "#ffffff", ring: true },
  { name: "Black", dot: "#1a1d24" },
  { name: "Silver", dot: "#c2c7cd" },
  { name: "Red", dot: "#c0392b" },
  { name: "Blue", dot: "#1f6feb" },
  { name: "Gray", dot: "#6b7280" },
  { name: "Green", dot: "#1f7a44" },
];

export function FieldAddVehicle({
  assignedLot,
  canSeeFinancials,
  onClose,
  onViewInventory,
}: {
  assignedLot: Location | null;
  canSeeFinancials: boolean;
  onClose: () => void;
  onViewInventory: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const plateRef = useRef<HTMLInputElement>(null);

  // Form fields
  const [plate, setPlate] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [color, setColor] = useState("");
  const [space, setSpace] = useState("");
  const [amount, setAmount] = useState(""); // dollars, string for input control
  const [method, setMethod] = useState<PayMethod | "">("");

  // Bottom-sheet picker: which field is open (make | model | null)
  const [picker, setPicker] = useState<null | "make" | "model">(null);

  // Saved recap (drives State 4). Null while the form is shown.
  const [saved, setSaved] = useState<null | {
    plate: string;
    makeModel: string;
    color: string;
    space: string;
    amount: number | null;
    method: PayMethod | "";
  }>(null);

  // Autofocus the plate on mount so the attendant can type immediately.
  useEffect(() => {
    const t = setTimeout(() => plateRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  const models = useMemo(
    () => MAKES.find((m) => m.make === make)?.models ?? [],
    [make],
  );

  const canSave = plate.trim().length > 0 && make.trim().length > 0;

  const addVehicle = useMutation({
    mutationFn: async () => {
      const makeModel = [make.trim(), model.trim()].filter(Boolean).join(" ");
      const body: Record<string, unknown> = {
        date: format(new Date(), "yyyy-MM-dd"),
        tz: TZ_OFFSET,
        licensePlate: plate.trim(),
        makeModel: makeModel || make.trim(),
        color: color.trim() || "Unknown",
      };
      if (space.trim()) body.space = space.trim();
      if (method) body.method = method;
      // Only attach the amount when staff may see financials. The server also
      // drops it defensively, but we avoid sending it at all when gated.
      if (canSeeFinancials && amount.trim()) {
        const n = Number(amount);
        if (Number.isFinite(n) && n >= 0) body.amount = n;
      }
      const res = await apiRequest("POST", "/api/paid-cars/manual", body);
      return (await res.json()) as {
        amount?: number | null;
        method?: PayMethod | null;
        space?: string | null;
      };
    },
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ["/api/paid-cars"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      // SMS-stub: there is no SMS trigger for "paid vehicle logged" in the
      // approved trigger set (request/release/check-in/check-out only), so we
      // intentionally do NOT dispatch a message here.
      setSaved({
        plate: plate.trim(),
        makeModel: [make.trim(), model.trim()].filter(Boolean).join(" "),
        color: color.trim(),
        space: space.trim(),
        amount: row?.amount ?? null,
        method: (row?.method as PayMethod | null) ?? "",
      });
      toast({
        title: "Vehicle logged",
        description: `${plate.trim()} added to ${assignedLot?.name ?? "the lot"} inventory.`,
      });
    },
    onError: (err: any) => {
      const msg = String(err?.message ?? "").replace(/^\d+:\s*/, "");
      toast({
        title: "Couldn't save vehicle",
        description: msg || "Something went wrong. Try again.",
        variant: "destructive",
      });
    },
  });

  // Reset the form for "Add another vehicle".
  function resetForm() {
    setPlate("");
    setMake("");
    setModel("");
    setColor("");
    setSpace("");
    setAmount("");
    setMethod("");
    setSaved(null);
    setTimeout(() => plateRef.current?.focus(), 120);
  }

  return (
    <div
      className="flex min-h-full flex-col"
      style={{ background: "#fff", fontFamily: FIELD_FONT, color: FIELD.ink }}
      data-testid="field-add-vehicle"
    >
      {/* Header — white with a close (X), matching the mockup */}
      <div
        className="flex items-center gap-3 border-b px-4 py-[15px]"
        style={{ borderColor: FIELD.line }}
      >
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-[9px]"
          style={{ background: FIELD.fieldBg }}
          aria-label="Close"
          data-testid="button-add-close"
        >
          <X className="h-[19px] w-[19px]" style={{ color: FIELD.ink2 }} />
        </button>
        <div className="text-base font-bold" data-testid="text-add-title">
          {saved ? "Vehicle logged" : "Add Paid Vehicle"}
        </div>
      </div>

      {saved ? (
        <SuccessState
          saved={saved}
          lotName={assignedLot?.name ?? "the lot"}
          onAddAnother={resetForm}
          onViewInventory={onViewInventory}
        />
      ) : (
        <>
          {/* Scrollable form body */}
          <div className="flex flex-1 flex-col gap-[18px] px-4 pb-[120px] pt-[18px]">
            {/* License plate */}
            <Field label="License plate">
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
                  data-testid="input-add-plate"
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

            {/* Make / Model */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Make">
                <PickerButton
                  value={make}
                  placeholder="Select…"
                  onClick={() => setPicker("make")}
                  testid="button-add-make"
                />
              </Field>
              <Field label="Model">
                <PickerButton
                  value={model}
                  placeholder="Select…"
                  disabled={!make}
                  onClick={() => make && setPicker("model")}
                  testid="button-add-model"
                />
              </Field>
            </div>

            {/* Color chips */}
            <Field label="Color">
              <div className="flex flex-wrap gap-2">
                {COLORS.map((c) => {
                  const active = color === c.name;
                  return (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => setColor(active ? "" : c.name)}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold"
                      style={{
                        background: active ? FIELD.accentSoft : "#fff",
                        color: active ? FIELD.accentInk : FIELD.ink2,
                        border: `1px solid ${active ? FIELD.accent : FIELD.line}`,
                      }}
                      data-testid={`chip-add-color-${c.name.toLowerCase()}`}
                    >
                      <span
                        className="h-[13px] w-[13px] rounded-full"
                        style={{
                          background: c.dot,
                          border: c.ring
                            ? `1px solid ${FIELD.line}`
                            : "1px solid rgba(0,0,0,.08)",
                        }}
                      />
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </Field>

            {/* Space / Row */}
            <Field label="Space / row">
              <input
                value={space}
                onChange={(e) => setSpace(e.target.value)}
                placeholder="e.g. Row C · #18"
                className="w-full rounded-[0.875rem] px-[13px] py-3 text-[14px] outline-none placeholder:text-[#94a1ad]"
                style={{
                  background: FIELD.fieldBg,
                  border: `1px solid ${FIELD.line}`,
                  color: FIELD.ink,
                }}
                data-testid="input-add-space"
              />
            </Field>

            {/* Payment */}
            <Field label="Payment">
              {canSeeFinancials ? (
                <>
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
                      value={amount}
                      onChange={(e) =>
                        setAmount(e.target.value.replace(/[^0-9.]/g, ""))
                      }
                      placeholder="amount collected"
                      inputMode="decimal"
                      className="w-full bg-transparent text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-[#94a1ad]"
                      style={{ fontFamily: FIELD_MONO, color: FIELD.ink }}
                      data-testid="input-add-amount"
                    />
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-2">
                    <MethodChip
                      label="Cash"
                      icon={<Banknote className="h-4 w-4" />}
                      active={method === "cash"}
                      onClick={() => setMethod(method === "cash" ? "" : "cash")}
                      testid="chip-add-method-cash"
                    />
                    <MethodChip
                      label="Card"
                      icon={<CreditCard className="h-4 w-4" />}
                      active={method === "card"}
                      onClick={() => setMethod(method === "card" ? "" : "card")}
                      testid="chip-add-method-card"
                    />
                    <MethodChip
                      label="App · QR"
                      icon={<QrCode className="h-4 w-4" />}
                      active={method === "app"}
                      onClick={() => setMethod(method === "app" ? "" : "app")}
                      testid="chip-add-method-app"
                    />
                  </div>
                </>
              ) : (
                // State 3 — financials gated: amount locked. Method stays usable
                // since it isn't a financial value, matching the mock's intent.
                <>
                  <div
                    className="flex items-center gap-2 rounded-[0.875rem] px-[13px] py-3"
                    style={{
                      background: FIELD.fieldBg,
                      border: `1px dashed ${FIELD.line}`,
                    }}
                    data-testid="add-amount-locked"
                  >
                    <Lock className="h-4 w-4" style={{ color: FIELD.ink3 }} />
                    <span
                      className="text-[12.5px] font-medium"
                      style={{ color: FIELD.ink3 }}
                    >
                      Payment amount hidden by admin settings
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-2">
                    <MethodChip
                      label="Cash"
                      icon={<Banknote className="h-4 w-4" />}
                      active={method === "cash"}
                      onClick={() => setMethod(method === "cash" ? "" : "cash")}
                      testid="chip-add-method-cash"
                    />
                    <MethodChip
                      label="Card"
                      icon={<CreditCard className="h-4 w-4" />}
                      active={method === "card"}
                      onClick={() => setMethod(method === "card" ? "" : "card")}
                      testid="chip-add-method-card"
                    />
                    <MethodChip
                      label="App · QR"
                      icon={<QrCode className="h-4 w-4" />}
                      active={method === "app"}
                      onClick={() => setMethod(method === "app" ? "" : "app")}
                      testid="chip-add-method-app"
                    />
                  </div>
                </>
              )}
            </Field>
          </div>

          {/* Sticky footer — orange Save (reserved primary action) */}
          <div
            className="sticky bottom-0 border-t px-4 py-3"
            style={{ background: "#fff", borderColor: FIELD.line }}
          >
            <button
              type="button"
              disabled={!canSave || addVehicle.isPending}
              onClick={() => addVehicle.mutate()}
              className="flex w-full items-center justify-center gap-2 rounded-[0.875rem] py-[15px] text-[15px] font-bold text-white"
              style={{
                background: canSave ? FIELD.orange : "#f0b89a",
                boxShadow: canSave ? "0 6px 16px rgba(232,86,10,.32)" : "none",
              }}
              data-testid="button-add-save"
            >
              {addVehicle.isPending ? (
                <>
                  <Loader2 className="h-[18px] w-[18px] animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Check className="h-[18px] w-[18px]" /> Save Paid Vehicle
                </>
              )}
            </button>
          </div>
        </>
      )}

      {/* Bottom-sheet picker (State 2) */}
      {picker && (
        <PickerSheet
          title={picker === "make" ? "Select make" : "Select model"}
          options={picker === "make" ? MAKES.map((m) => m.make) : models}
          selected={picker === "make" ? make : model}
          customLabel={picker === "make" ? "Add custom make" : "Add custom model"}
          onPick={(val) => {
            if (picker === "make") {
              setMake(val);
              setModel(""); // reset model when make changes
            } else {
              setModel(val);
            }
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

// ---- Small building blocks -------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em]"
        style={{ color: FIELD.ink2 }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function PickerButton({
  value,
  placeholder,
  disabled,
  onClick,
  testid,
}: {
  value: string;
  placeholder: string;
  disabled?: boolean;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-between rounded-[0.875rem] px-[13px] py-3 text-left text-[14px]"
      style={{
        background: FIELD.fieldBg,
        border: `1px solid ${FIELD.line}`,
        color: value ? FIELD.ink : FIELD.ink3,
        opacity: disabled ? 0.55 : 1,
      }}
      data-testid={testid}
    >
      <span className="truncate font-semibold">{value || placeholder}</span>
      <ChevronDown className="h-[17px] w-[17px] shrink-0" style={{ color: FIELD.ink3 }} />
    </button>
  );
}

function MethodChip({
  label,
  icon,
  active,
  onClick,
  testid,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center gap-1.5 rounded-[0.75rem] py-2.5 text-[12.5px] font-semibold"
      style={{
        background: active ? FIELD.accentSoft : "#fff",
        color: active ? FIELD.accentInk : FIELD.ink2,
        border: `1px solid ${active ? FIELD.accent : FIELD.line}`,
      }}
      data-testid={testid}
    >
      {icon}
      {label}
    </button>
  );
}

function PickerSheet({
  title,
  options,
  selected,
  customLabel,
  onPick,
  onClose,
}: {
  title: string;
  options: string[];
  selected: string;
  customLabel: string;
  onPick: (val: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      options.filter((o) =>
        o.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [options, query],
  );
  const canAddCustom = query.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-30 flex items-end"
      style={{ background: "rgba(13,27,42,.45)" }}
      onClick={onClose}
      data-testid="add-picker-sheet"
    >
      <div
        className="max-h-[72vh] w-full overflow-hidden rounded-t-[1.25rem] bg-white"
        onClick={(e) => e.stopPropagation()}
        style={{ fontFamily: FIELD_FONT }}
      >
        {/* Grab handle */}
        <div className="flex justify-center pb-1 pt-2.5">
          <span
            className="h-1 w-10 rounded-full"
            style={{ background: FIELD.line }}
          />
        </div>
        <div
          className="px-4 pb-2 pt-1 text-[11px] font-bold uppercase tracking-[0.06em]"
          style={{ color: FIELD.ink2 }}
        >
          {title}
        </div>
        {/* Search */}
        <div className="px-4 pb-2">
          <div
            className="flex items-center gap-2 rounded-[0.875rem] px-[13px] py-2.5"
            style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
          >
            <SearchIcon className="h-[16px] w-[16px]" style={{ color: FIELD.ink3 }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              autoFocus
              className="w-full bg-transparent text-[14px] outline-none placeholder:text-[#94a1ad]"
              style={{ color: FIELD.ink }}
              data-testid="input-picker-search"
            />
          </div>
        </div>
        {/* Options */}
        <div className="max-h-[44vh] overflow-y-auto pb-1">
          {filtered.map((o) => {
            const active = o === selected;
            return (
              <button
                key={o}
                type="button"
                onClick={() => onPick(o)}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-[14px]"
                style={{
                  color: active ? FIELD.accent : FIELD.ink,
                  background: active ? FIELD.accentSoft : "transparent",
                  fontWeight: active ? 700 : 500,
                }}
                data-testid={`option-picker-${o.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {o}
                {active && <Check className="h-[17px] w-[17px]" />}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div
              className="px-4 py-6 text-center text-[13px]"
              style={{ color: FIELD.ink3 }}
            >
              No matches.
            </div>
          )}
        </div>
        {/* Add custom */}
        <button
          type="button"
          disabled={!canAddCustom}
          onClick={() => canAddCustom && onPick(query.trim())}
          className="flex w-full items-center justify-between border-t px-4 py-3.5 text-[14px] font-semibold"
          style={{
            borderColor: FIELD.line,
            color: canAddCustom ? FIELD.accent : FIELD.ink3,
          }}
          data-testid="button-picker-add-custom"
        >
          <span className="flex items-center gap-2">
            <Plus className="h-[17px] w-[17px]" />
            {canAddCustom ? `Add "${query.trim()}"` : customLabel}
          </span>
        </button>
      </div>
    </div>
  );
}

function SuccessState({
  saved,
  lotName,
  onAddAnother,
  onViewInventory,
}: {
  saved: {
    plate: string;
    makeModel: string;
    color: string;
    space: string;
    amount: number | null;
    method: PayMethod | "";
  };
  lotName: string;
  onAddAnother: () => void;
  onViewInventory: () => void;
}) {
  const methodLabel: Record<PayMethod, string> = {
    cash: "Cash",
    card: "Card",
    app: "App",
  };
  // Recap line: "Toyota Corolla · White · Row C #18"
  const recap = [saved.makeModel, saved.color, saved.space]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" · ");
  // Payment line: "$40.00 · Cash · Paid" (amount only when present)
  const payParts: string[] = [];
  if (saved.amount != null)
    payParts.push(
      saved.amount.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      }),
    );
  if (saved.method) payParts.push(methodLabel[saved.method]);
  payParts.push("Paid");
  const payLine = payParts.join(" · ");

  return (
    <div
      className="flex flex-1 flex-col items-center px-6 pb-[110px] pt-12 text-center"
      data-testid="add-success"
    >
      <div
        className="flex h-[72px] w-[72px] items-center justify-center rounded-full"
        style={{ background: "#e4f4ea" }}
      >
        <CheckCircle2 className="h-10 w-10" style={{ color: "#1f7a44" }} />
      </div>
      <div className="mt-4 text-[18px] font-extrabold" style={{ color: FIELD.ink }}>
        Vehicle logged
      </div>
      <div className="mt-1 text-[13px]" style={{ color: FIELD.ink3 }}>
        Added to {lotName} inventory.
      </div>

      <span
        className="mt-6 rounded-md px-3 py-2 text-[15px] font-bold tracking-[0.1em] text-white"
        style={{ fontFamily: FIELD_MONO, background: "#1a1d24", border: "1px solid #333" }}
        data-testid="add-success-plate"
      >
        {saved.plate}
      </span>
      {recap && (
        <div className="mt-3 text-[13px]" style={{ color: FIELD.ink2 }}>
          {recap}
        </div>
      )}
      <div
        className="mt-1 text-[13px] font-semibold"
        style={{ color: "#1f7a44" }}
        data-testid="add-success-payment"
      >
        {payLine}
      </div>

      <div className="mt-8 flex w-full max-w-[320px] flex-col gap-2.5">
        <button
          type="button"
          onClick={onAddAnother}
          className="flex w-full items-center justify-center gap-2 rounded-[0.875rem] py-[15px] text-[15px] font-bold text-white"
          style={{ background: FIELD.accent }}
          data-testid="button-add-another"
        >
          <Plus className="h-[18px] w-[18px]" /> Add Another Vehicle
        </button>
        <button
          type="button"
          onClick={onViewInventory}
          className="w-full rounded-[0.875rem] py-[14px] text-[14px] font-bold"
          style={{ color: FIELD.accent, border: `1px solid ${FIELD.line}` }}
          data-testid="button-add-view-inventory"
        >
          View Inventory
        </button>
      </div>
    </div>
  );
}
