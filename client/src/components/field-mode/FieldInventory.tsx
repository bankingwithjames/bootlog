import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Search as SearchIcon,
  Car,
  Tag,
  Hash,
  Clock,
  Wallet,
  CreditCard,
  Pencil,
  Loader2,
  X,
} from "lucide-react";
import type { Boot, Location } from "@shared/schema";
import { apiRequest, queryClient as gqc } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FIELD, FIELD_MONO } from "./FieldShell";

// ---------------------------------------------------------------------------
// FieldInventory — attendant Inventory list + vehicle detail + quick actions
// (Page 4). Wires the three approved states from page4_shot.png to the live v2
// backend:
//   State 1: lot-scoped inventory list, grouped by status, search + filter
//            chips (All / Unpaid / Booted / Paid). Unpaid chip is red.
//   State 2: tap a row -> vehicle detail bottom-sheet with quick actions:
//            Request Boot Release (primary, orange) / Mark as Paid (blue) /
//            Edit Vehicle Details (white).
//   State 3: empty/filtered state with a Clear filters affordance.
//
// Inventory = today's boots (lot-scoped by the caller) cross-referenced with
// today's paid plates (/api/paid-cars). Financials ($ amounts) are gated by
// canSeeFinancials; the server is authoritative.
//
// Permission model (LOCKED): attendants may "Mark as Paid" (closes a booted
// vehicle as paid in full -> PATCH /api/boots/:id/mark-paid). Attendants cannot
// remove boots; "Request Boot Release" queues a release_requests row + fires the
// stubbed SMS to the enforcer (POST /api/release-requests).
// ---------------------------------------------------------------------------

function normalizePlate(plate: string): string {
  return (plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function currency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function timeLabel(iso: string): string {
  try {
    return format(parseISO(iso), "h:mm a");
  } catch {
    return "";
  }
}

// Human "time on boot" since bootedAt (e.g. "42 min", "3h 12m").
function durationSince(iso: string): string {
  try {
    const ms = Date.now() - parseISO(iso).getTime();
    if (ms < 0) return "0 min";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  } catch {
    return "—";
  }
}

// Derived status (mirrors FieldHome): maps the enforcement lifecycle +
// paid-plate cross-reference onto the three council-approved badges.
type DerivedStatus = {
  key: "unpaid" | "released" | "paid";
  label: string;
  color: string; // text + left stripe
  fill: string; // pill background
};

const STATUS: Record<DerivedStatus["key"], Omit<DerivedStatus, "key">> = {
  unpaid: { label: "Booted · Unpaid", color: "#c0392b", fill: "#fdecea" },
  released: { label: "Released", color: "#1f6feb", fill: "#e8f0fe" },
  paid: { label: "Resolved · Paid", color: "#1f7a44", fill: "#e4f4ea" },
};

function deriveStatus(b: Boot): DerivedStatus {
  const s = b.status ?? "booted";
  if (s === "released") return { key: "released", ...STATUS.released };
  if (s === "settled" || s === "completed")
    return { key: "paid", ...STATUS.paid };
  return { key: "unpaid", ...STATUS.unpaid };
}

type PaidCarLite = { licensePlate: string };
type ChipFilter = "all" | "unpaid" | "booted" | "paid";

export function FieldInventory({
  todayBoots,
  paidCars,
  assignedLot,
  canSeeFinancials,
  onBack,
}: {
  // Boots already scoped to the assigned lot + today by the caller.
  todayBoots: Boot[];
  paidCars: PaidCarLite[];
  assignedLot: Location | null;
  canSeeFinancials: boolean;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<ChipFilter>("all");
  const [openBoot, setOpenBoot] = useState<Boot | null>(null);

  const paidPlates = useMemo(
    () =>
      new Set(
        paidCars.map((c) => normalizePlate(c.licensePlate)).filter(Boolean),
      ),
    [paidCars],
  );

  // Newest-first with derived status attached.
  const rows = useMemo(
    () =>
      [...todayBoots]
        .sort(
          (a, b) =>
            new Date(b.bootedAt).getTime() - new Date(a.bootedAt).getTime(),
        )
        .map((b) => ({ boot: b, status: deriveStatus(b) })),
    [todayBoots],
  );

  const unpaidCount = useMemo(
    () =>
      todayBoots.filter(
        (b) =>
          (b.status ?? "booted") === "booted" &&
          !paidPlates.has(normalizePlate(b.licensePlate)),
      ).length,
    [todayBoots, paidPlates],
  );
  const bootedCount = useMemo(
    () => todayBoots.filter((b) => (b.status ?? "booted") === "booted").length,
    [todayBoots],
  );
  const paidStatusCount = useMemo(
    () =>
      todayBoots.filter(
        (b) => b.status === "settled" || b.status === "completed",
      ).length,
    [todayBoots],
  );

  // Apply search + chip filter.
  const filtered = useMemo(() => {
    const q = normalizePlate(search);
    const qText = search.trim().toUpperCase();
    return rows.filter(({ boot, status }) => {
      if (q) {
        const plateMatch = normalizePlate(boot.licensePlate).includes(q);
        const textMatch = (boot.makeModel ?? "").toUpperCase().includes(qText);
        if (!plateMatch && !textMatch) return false;
      }
      if (chip === "all") return true;
      if (chip === "unpaid")
        return (
          status.key === "unpaid" &&
          !paidPlates.has(normalizePlate(boot.licensePlate))
        );
      if (chip === "booted") return (boot.status ?? "booted") === "booted";
      if (chip === "paid")
        return boot.status === "settled" || boot.status === "completed";
      return true;
    });
  }, [rows, search, chip, paidPlates]);

  // Group filtered rows into the two council-approved sections: vehicles that
  // still need attention (booted/unpaid) and everything resolved (paid/
  // released). Preserves the newest-first order within each group.
  const grouped = useMemo(() => {
    const attention = filtered.filter(
      (r) => r.status.key === "unpaid",
    );
    const resolved = filtered.filter((r) => r.status.key !== "unpaid");
    return { attention, resolved };
  }, [filtered]);

  const hasFilter = chip !== "all" || search.trim().length > 0;
  const clearFilters = () => {
    setChip("all");
    setSearch("");
  };

  const lotName = assignedLot?.name ?? "Your lot";

  // --- Mutations -----------------------------------------------------------
  const markPaid = useMutation({
    mutationFn: async (bootId: number) => {
      const res = await apiRequest("PATCH", `/api/boots/${bootId}/mark-paid`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/boots"] });
      gqc.invalidateQueries({ queryKey: ["/api/boots"] });
      toast({
        title: "Marked as paid",
        description: "Boot closed and full fee recorded as collected.",
      });
      setOpenBoot(null);
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't mark as paid",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const requestRelease = useMutation({
    mutationFn: async (bootId: number) => {
      const res = await apiRequest("POST", "/api/release-requests", {
        bootId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/release-requests"] });
      toast({
        title: "Release requested",
        description: "An enforcer has been notified to remove the boot.",
      });
      setOpenBoot(null);
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't request release",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const headerCount = hasFilter
    ? `${filtered.length} result${filtered.length === 1 ? "" : "s"}`
    : `${todayBoots.length} vehicle${todayBoots.length === 1 ? "" : "s"}`;

  return (
    <div data-testid="field-inventory">
      {/* Sub-header strip (inside the shell body, below the global header). */}
      <div
        className="flex items-center justify-between px-[14px] pb-1 pt-3.5"
        data-testid="inventory-subheader"
      >
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="flex h-9 w-9 items-center justify-center rounded-full"
            style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
            aria-label="Back to home"
            data-testid="button-inventory-back"
          >
            <ChevronLeft className="h-5 w-5" style={{ color: FIELD.ink }} />
          </button>
          <div>
            <h2 className="text-[17px] font-extrabold leading-tight" style={{ color: FIELD.ink }}>
              Inventory
            </h2>
            <div className="text-[12px] font-medium" style={{ color: FIELD.ink3 }}>
              {lotName} · Today
            </div>
          </div>
        </div>
        <div
          className="text-[12px] font-semibold"
          style={{ color: FIELD.ink2 }}
          data-testid="inventory-count"
        >
          {headerCount}
        </div>
      </div>

      <div className="flex flex-col gap-[13px] px-[14px] pb-[96px] pt-2">
        {/* Search */}
        <div
          className="flex items-center gap-[9px] rounded-[0.875rem] px-[13px] py-3 text-[13.5px]"
          style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
        >
          <SearchIcon className="h-[17px] w-[17px]" style={{ color: FIELD.ink3 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plate, make or model…"
            className="w-full bg-transparent outline-none placeholder:text-[#94a1ad]"
            style={{ color: FIELD.ink }}
            data-testid="input-inventory-search"
          />
          {search.length > 0 && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              data-testid="button-inventory-clear-search"
            >
              <X className="h-4 w-4" style={{ color: FIELD.ink3 }} />
            </button>
          )}
        </div>

        {/* Filter chips */}
        <div className="flex gap-[7px] overflow-x-auto pb-0.5">
          <Chip
            label={`All · ${todayBoots.length}`}
            active={chip === "all"}
            onClick={() => setChip("all")}
            testid="chip-inventory-all"
          />
          <Chip
            label={`Unpaid · ${unpaidCount}`}
            risk
            active={chip === "unpaid"}
            onClick={() => setChip("unpaid")}
            testid="chip-inventory-unpaid"
          />
          <Chip
            label={`Booted · ${bootedCount}`}
            active={chip === "booted"}
            onClick={() => setChip("booted")}
            testid="chip-inventory-booted"
          />
          <Chip
            label={`Paid · ${paidStatusCount}`}
            active={chip === "paid"}
            onClick={() => setChip("paid")}
            testid="chip-inventory-paid"
          />
        </div>

        {/* List or empty state */}
        {filtered.length === 0 ? (
          <EmptyState
            chip={chip}
            hasFilter={hasFilter}
            onClear={clearFilters}
          />
        ) : (
          <div className="flex flex-col gap-4" data-testid="inventory-list">
            {grouped.attention.length > 0 && (
              <Group title="Booted · Needs attention">
                {grouped.attention.map(({ boot, status }) => (
                  <InventoryRow
                    key={boot.id}
                    boot={boot}
                    status={status}
                    canSeeFinancials={canSeeFinancials}
                    onClick={() => setOpenBoot(boot)}
                  />
                ))}
              </Group>
            )}
            {grouped.resolved.length > 0 && (
              <Group title="Paid / Resolved today">
                {grouped.resolved.map(({ boot, status }) => (
                  <InventoryRow
                    key={boot.id}
                    boot={boot}
                    status={status}
                    canSeeFinancials={canSeeFinancials}
                    onClick={() => setOpenBoot(boot)}
                  />
                ))}
              </Group>
            )}
          </div>
        )}
      </div>

      {/* Vehicle detail bottom-sheet */}
      {openBoot && (
        <VehicleSheet
          boot={openBoot}
          canSeeFinancials={canSeeFinancials}
          markPaidPending={markPaid.isPending}
          releasePending={requestRelease.isPending}
          onClose={() => setOpenBoot(null)}
          onMarkPaid={() => markPaid.mutate(openBoot.id)}
          onRequestRelease={() => requestRelease.mutate(openBoot.id)}
        />
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3
        className="mb-2 px-0.5 text-[11px] font-bold uppercase tracking-[0.07em]"
        style={{ color: FIELD.ink3 }}
      >
        {title}
      </h3>
      <div
        className="overflow-hidden rounded-[0.875rem]"
        style={{ background: "#fff", border: `1px solid ${FIELD.line}` }}
      >
        {children}
      </div>
    </section>
  );
}

function InventoryRow({
  boot,
  status,
  canSeeFinancials,
  onClick,
}: {
  boot: Boot;
  status: DerivedStatus;
  canSeeFinancials: boolean;
  onClick: () => void;
}) {
  const time = timeLabel(boot.bootedAt);
  const meta = [boot.color, time].filter(Boolean).join(" · ");
  const amount =
    status.key === "paid" ? boot.amountCollected ?? 0 : boot.bootFee ?? 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-[11px] px-[13px] py-[13px] text-left"
      style={{
        borderLeft: `3px solid ${status.color}`,
        borderBottom: `1px solid ${FIELD.line}`,
      }}
      data-testid={`row-inventory-${boot.id}`}
    >
      <span
        className="min-w-[80px] rounded-md px-2 py-1.5 text-center text-[13.5px] font-bold tracking-[0.05em] text-white"
        style={{
          fontFamily: FIELD_MONO,
          background: "#1a1d24",
          border: "1px solid #333",
        }}
        data-testid={`plate-inventory-${boot.id}`}
      >
        {boot.licensePlate}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold" style={{ color: FIELD.ink }}>
          {boot.makeModel}
        </span>
        {meta && (
          <span className="mt-0.5 block text-[11px]" style={{ color: FIELD.ink3 }}>
            {meta}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span
          className="inline-block rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.02em]"
          style={{ background: status.fill, color: status.color }}
          data-testid={`status-inventory-${boot.id}`}
        >
          {status.label}
        </span>
        <span className="mt-[5px] block">
          {canSeeFinancials ? (
            <span
              className="text-[12px] font-semibold"
              style={{ fontFamily: FIELD_MONO, color: FIELD.ink2 }}
            >
              {currency(amount)}
            </span>
          ) : (
            <span className="text-[11px]" style={{ color: FIELD.ink3 }}>
              •••
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function VehicleSheet({
  boot,
  canSeeFinancials,
  markPaidPending,
  releasePending,
  onClose,
  onMarkPaid,
  onRequestRelease,
}: {
  boot: Boot;
  canSeeFinancials: boolean;
  markPaidPending: boolean;
  releasePending: boolean;
  onClose: () => void;
  onMarkPaid: () => void;
  onRequestRelease: () => void;
}) {
  const status = deriveStatus(boot);
  const isBooted = (boot.status ?? "booted") === "booted";
  const busy = markPaidPending || releasePending;

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center"
      data-testid="vehicle-sheet"
    >
      {/* Scrim */}
      <button
        type="button"
        className="absolute inset-0"
        style={{ background: "rgba(13,27,42,0.45)" }}
        onClick={busy ? undefined : onClose}
        aria-label="Close"
        data-testid="vehicle-sheet-scrim"
      />
      <div
        className="relative w-full max-w-[440px] rounded-t-[20px] bg-white pb-[max(20px,env(safe-area-inset-bottom))]"
        style={{ boxShadow: "0 -8px 32px rgba(13,27,42,0.18)" }}
      >
        {/* Grab handle */}
        <div className="flex justify-center pt-2.5">
          <span
            className="h-1 w-9 rounded-full"
            style={{ background: FIELD.line }}
          />
        </div>

        {/* Header: plate chip + make/model */}
        <div className="flex items-center gap-[11px] px-[18px] pb-3 pt-3">
          <span
            className="rounded-md px-2.5 py-2 text-center text-[14px] font-bold tracking-[0.05em] text-white"
            style={{
              fontFamily: FIELD_MONO,
              background: "#1a1d24",
              border: "1px solid #333",
            }}
            data-testid="vehicle-sheet-plate"
          >
            {boot.licensePlate}
          </span>
          <div className="min-w-0">
            <div className="text-[17px] font-extrabold leading-tight" style={{ color: FIELD.ink }}>
              {boot.makeModel}
            </div>
            {boot.color && (
              <div className="text-[12.5px] font-medium" style={{ color: FIELD.ink3 }}>
                {boot.color}
              </div>
            )}
          </div>
        </div>

        {/* Detail rows */}
        <div className="border-t" style={{ borderColor: FIELD.line }}>
          <DetailRow
            icon={<Tag className="h-[18px] w-[18px]" />}
            label="Status"
            testid="vehicle-sheet-status"
          >
            <span
              className="rounded-full px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.02em]"
              style={{ background: status.fill, color: status.color }}
            >
              {status.label}
            </span>
          </DetailRow>
          <DetailRow
            icon={<Clock className="h-[18px] w-[18px]" />}
            label="Booted at"
            testid="vehicle-sheet-booted-at"
          >
            <span className="text-[14px] font-semibold" style={{ fontFamily: FIELD_MONO, color: FIELD.ink }}>
              {timeLabel(boot.bootedAt) || "—"}
            </span>
          </DetailRow>
          {isBooted && (
            <DetailRow
              icon={<Hash className="h-[18px] w-[18px]" />}
              label="Time on boot"
              testid="vehicle-sheet-time-on-boot"
            >
              <span className="text-[14px] font-semibold" style={{ fontFamily: FIELD_MONO, color: FIELD.ink }}>
                {durationSince(boot.bootedAt)}
              </span>
            </DetailRow>
          )}
          <DetailRow
            icon={<Wallet className="h-[18px] w-[18px]" />}
            label="Amount"
            testid="vehicle-sheet-amount"
            last
          >
            {canSeeFinancials ? (
              <span
                className="text-[14px] font-bold"
                style={{
                  fontFamily: FIELD_MONO,
                  color: status.key === "paid" ? "#1f7a44" : "#c0392b",
                }}
              >
                {status.key === "paid"
                  ? `${currency(boot.amountCollected ?? 0)} paid`
                  : `${currency(boot.bootFee ?? 0)} due`}
              </span>
            ) : (
              <span className="text-[13px] font-semibold" style={{ color: FIELD.ink3 }}>
                Hidden by admin
              </span>
            )}
          </DetailRow>
        </div>

        {/* Quick actions */}
        <div className="flex flex-col gap-2.5 px-[18px] pt-4">
          {isBooted ? (
            <>
              <button
                type="button"
                onClick={busy ? undefined : onRequestRelease}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-[0.875rem] py-[14px] text-[14.5px] font-bold text-white disabled:opacity-70"
                style={{ background: FIELD.orange }}
                data-testid="button-request-release"
              >
                {releasePending ? (
                  <Loader2 className="h-[19px] w-[19px] animate-spin" />
                ) : (
                  <ReleaseGlyph />
                )}
                Request Boot Release
              </button>
              <button
                type="button"
                onClick={busy ? undefined : onMarkPaid}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-[0.875rem] py-[14px] text-[14.5px] font-bold disabled:opacity-70"
                style={{
                  background: FIELD.accentSoft,
                  color: FIELD.accentInk,
                  border: "1px solid rgba(31,111,235,0.22)",
                }}
                data-testid="button-mark-paid"
              >
                {markPaidPending ? (
                  <Loader2 className="h-[19px] w-[19px] animate-spin" />
                ) : (
                  <CreditCard className="h-[19px] w-[19px]" />
                )}
                Mark as Paid
              </button>
            </>
          ) : (
            <div
              className="rounded-[0.875rem] px-3.5 py-3 text-center text-[12.5px] font-medium"
              style={{ background: FIELD.fieldBg, color: FIELD.ink2, border: `1px solid ${FIELD.line}` }}
              data-testid="vehicle-sheet-resolved-note"
            >
              This vehicle is already resolved — no boot actions needed.
            </div>
          )}
          <button
            type="button"
            onClick={busy ? undefined : onClose}
            disabled={busy}
            className="flex items-center justify-center gap-2 rounded-[0.875rem] py-[13px] text-[14px] font-semibold disabled:opacity-70"
            style={{ background: "#fff", color: FIELD.ink2, border: `1px solid ${FIELD.line}` }}
            data-testid="button-edit-vehicle"
          >
            <Pencil className="h-[17px] w-[17px]" />
            Edit Vehicle Details
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  children,
  last,
  testid,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  last?: boolean;
  testid: string;
}) {
  return (
    <div
      className="flex items-center justify-between px-[18px] py-[13px]"
      style={{ borderBottom: last ? "none" : `1px solid ${FIELD.line}` }}
      data-testid={testid}
    >
      <span className="flex items-center gap-2.5 text-[13.5px] font-medium" style={{ color: FIELD.ink2 }}>
        <span style={{ color: FIELD.ink3 }}>{icon}</span>
        {label}
      </span>
      {children}
    </div>
  );
}

function EmptyState({
  chip,
  hasFilter,
  onClear,
}: {
  chip: ChipFilter;
  hasFilter: boolean;
  onClear: () => void;
}) {
  const sub =
    chip === "unpaid"
      ? "No unpaid vehicles match your search right now — nice, the lot is clean."
      : "No vehicles match your search or filter right now.";
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-[0.875rem] px-6 py-12 text-center"
      style={{ background: "#fff", border: `1px solid ${FIELD.line}` }}
      data-testid="inventory-empty"
    >
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: FIELD.fieldBg }}
      >
        <Car className="h-7 w-7" style={{ color: FIELD.ink3 }} />
      </div>
      <div className="text-[15px] font-bold" style={{ color: FIELD.ink }}>
        No matching vehicles
      </div>
      <p className="max-w-[16rem] text-[13px]" style={{ color: FIELD.ink3 }}>
        {sub}
      </p>
      {hasFilter && (
        <button
          type="button"
          onClick={onClear}
          className="mt-1 rounded-[0.875rem] px-5 py-2.5 text-[13px] font-bold"
          style={{
            background: FIELD.accentSoft,
            color: FIELD.accentInk,
            border: "1px solid rgba(31,111,235,0.22)",
          }}
          data-testid="button-clear-filters"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function Chip({
  label,
  active,
  risk,
  onClick,
  testid,
}: {
  label: string;
  active: boolean;
  risk?: boolean;
  onClick: () => void;
  testid: string;
}) {
  let style: React.CSSProperties;
  if (active) {
    style = risk
      ? { background: "#c0392b", color: "#fff", border: "1px solid #c0392b" }
      : { background: FIELD.header, color: "#fff", border: `1px solid ${FIELD.header}` };
  } else if (risk) {
    style = { background: "#fdecea", color: "#c0392b", border: "1px solid #f5c6c0" };
  } else {
    style = { background: "#fff", color: FIELD.ink2, border: `1px solid ${FIELD.line}` };
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap rounded-full px-3.5 py-[7px] text-[12px] font-semibold"
      style={style}
      data-testid={testid}
    >
      {label}
    </button>
  );
}

// Boot-release glyph (boot icon with an outward arrow) — matches the mockup's
// custom action icon; lucide has no exact match.
function ReleaseGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[19px] w-[19px]"
    >
      <path d="M4 4v9a4 4 0 0 0 4 4h5l3 2v-6a3 3 0 0 0-3-3H8" />
      <path d="M4 9h6" />
    </svg>
  );
}
