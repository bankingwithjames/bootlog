import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { Car, Lock, Search as SearchIcon, ChevronRight } from "lucide-react";
import type { Boot, Location, Shift } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import {
  FieldShell,
  FIELD,
  FIELD_MONO,
  type FieldView,
} from "./FieldShell";
import { FieldShift } from "./FieldShift";
import { FieldAddVehicle } from "./FieldAddVehicle";
import { FieldInventory } from "./FieldInventory";

// Minimal shape of a paid car (from /api/paid-cars). Field Mode only needs the
// plate for cross-reference and counting; full type lives in home.tsx.
type PaidCarLite = {
  licensePlate: string;
};

// Normalize a plate for matching: uppercase, strip non-alphanumerics. Mirrors
// the helper in home.tsx (kept local to avoid widening that module's exports).
function normalizePlate(plate: string): string {
  return (plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function currency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Short "started at" label for the header shift bar (e.g. "9:53 AM").
function shiftStartLabel(iso: string): string {
  try {
    return format(parseISO(iso), "h:mm a");
  } catch {
    return "now";
  }
}

// Consolidated derived status shown as a single pill + left-edge color stripe.
// Maps the enforcement lifecycle (+ paid cross-reference) onto the three
// council-approved states from the mockup.
type DerivedStatus = {
  key: "unpaid" | "released" | "paid";
  label: string;
  color: string; // text/stripe
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
  // booted (active) → unpaid / at risk
  return { key: "unpaid", ...STATUS.unpaid };
}

type ChipFilter = "all" | "unpaid" | "booted" | "released" | "paid";

export type FieldHomeData = {
  // Boots already scoped to the attendant's assigned lot + today by the caller.
  todayBoots: Boot[];
  // Count of paid vehicles at the assigned lot today (from /api/paid-cars).
  paidCount: number;
  // Normalized plates paid today (cross-reference for "unpaid at risk").
  paidPlates: Set<string>;
  assignedLot: Location | null;
  canSeeFinancials: boolean;
};

export function FieldHome({
  data,
  onAddPaid,
  onRequestBoot,
  onOpenBoot,
  onSeeInventory,
}: {
  data: FieldHomeData;
  onAddPaid: () => void;
  onRequestBoot: () => void;
  onOpenBoot: (boot: Boot) => void;
  onSeeInventory: () => void;
}) {
  const { todayBoots, paidCount, paidPlates, assignedLot, canSeeFinancials } =
    data;

  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<ChipFilter>("all");

  // Newest-first, with derived status attached.
  const rows = useMemo(() => {
    return [...todayBoots]
      .sort(
        (a, b) =>
          new Date(b.bootedAt).getTime() - new Date(a.bootedAt).getTime(),
      )
      .map((b) => ({ boot: b, status: deriveStatus(b) }));
  }, [todayBoots]);

  // KPI counts (always shown — counts are not financials).
  const bootedToday = todayBoots.length;
  const unpaidAtRisk = useMemo(
    () =>
      todayBoots.filter(
        (b) =>
          (b.status ?? "booted") === "booted" &&
          !paidPlates.has(normalizePlate(b.licensePlate)),
      ).length,
    [todayBoots, paidPlates],
  );
  const collectedToday = useMemo(
    () => todayBoots.reduce((s, b) => s + (b.amountCollected ?? 0), 0),
    [todayBoots],
  );

  const filtered = useMemo(() => {
    const q = normalizePlate(search);
    return rows.filter(({ boot, status }) => {
      if (q && !normalizePlate(boot.licensePlate).includes(q)) {
        // also match make/model text loosely
        if (
          !(boot.makeModel ?? "")
            .toUpperCase()
            .includes(search.trim().toUpperCase())
        )
          return false;
      }
      if (chip === "all") return true;
      if (chip === "unpaid")
        return (
          status.key === "unpaid" &&
          !paidPlates.has(normalizePlate(boot.licensePlate))
        );
      if (chip === "booted") return (boot.status ?? "booted") === "booted";
      if (chip === "released") return boot.status === "released";
      if (chip === "paid")
        return boot.status === "settled" || boot.status === "completed";
      return true;
    });
  }, [rows, search, chip, paidPlates]);

  const lotName = assignedLot?.name ?? "Your lot";
  const lotShort = assignedLot?.name ?? "your lot";

  return (
    <div className="flex flex-col gap-[18px] px-[14px] pb-[92px] pt-4">
      {/* KPI grid (2x2) */}
      <section>
        <SectionHeader title={`Today · ${lotShort}`} actionLabel="View all ›" onAction={onSeeInventory} />
        <div className="grid grid-cols-2 gap-2.5">
          <Kpi
            value={String(paidCount)}
            label="Paid vehicles"
            valueColor={FIELD.accentInk}
            testid="field-kpi-paid"
          />
          <Kpi
            value={String(bootedToday)}
            label="Booted today"
            testid="field-kpi-booted"
          />
          <Kpi
            value={String(unpaidAtRisk)}
            label="Unpaid · at risk"
            alert
            testid="field-kpi-unpaid"
          />
          {canSeeFinancials ? (
            <Kpi
              value={currency(collectedToday)}
              label="Collected today"
              testid="field-kpi-collected"
            />
          ) : (
            <div
              className="rounded-[0.875rem] px-3.5 py-[13px]"
              style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
              data-testid="field-kpi-collected-locked"
            >
              <div
                className="text-[18px] font-extrabold leading-none tracking-[0.1em]"
                style={{ fontFamily: FIELD_MONO, color: FIELD.ink3 }}
              >
                •••••
              </div>
              <div
                className="mt-1.5 flex items-center gap-1 text-[10.5px] font-semibold"
                style={{ color: FIELD.ink3 }}
              >
                <Lock className="h-3 w-3" /> Hidden by admin
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Action buttons */}
      <section className="grid grid-cols-2 gap-[11px]">
        <button
          type="button"
          onClick={onAddPaid}
          className="flex flex-col gap-2 rounded-[0.875rem] px-3.5 py-[15px] text-left text-sm font-bold text-white"
          style={{ background: FIELD.orange }}
          data-testid="button-field-add-paid"
        >
          <Car className="h-[23px] w-[23px]" />
          <span>Add Paid Vehicle</span>
          <span className="text-[11px] font-medium opacity-85">Log a payment</span>
        </button>
        <button
          type="button"
          onClick={onRequestBoot}
          className="flex flex-col gap-2 rounded-[0.875rem] px-3.5 py-[15px] text-left text-sm font-bold"
          style={{
            background: FIELD.accentSoft,
            color: FIELD.accentInk,
            border: "1px solid rgba(31,111,235,0.22)",
          }}
          data-testid="button-field-request-boot"
        >
          <BootGlyph />
          <span>Request a Boot</span>
          <span className="text-[11px] font-medium opacity-85">Alert enforcer</span>
        </button>
      </section>

      {/* Recent activity */}
      <section>
        <SectionHeader
          title="Recent activity"
          actionLabel="See inventory ›"
          onAction={onSeeInventory}
        />
        {/* Search */}
        <div
          className="mb-[11px] flex items-center gap-[9px] rounded-[0.875rem] px-[13px] py-3 text-[13.5px]"
          style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
        >
          <SearchIcon className="h-[17px] w-[17px]" style={{ color: FIELD.ink3 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plate or vehicle…"
            className="w-full bg-transparent outline-none placeholder:text-[#94a1ad]"
            style={{ color: FIELD.ink }}
            data-testid="input-field-search"
          />
        </div>

        {/* Filter chips */}
        <div className="mb-[11px] flex gap-[7px] overflow-x-auto pb-0.5">
          <Chip
            label="All"
            active={chip === "all"}
            onClick={() => setChip("all")}
            testid="chip-field-all"
          />
          <Chip
            label={`Unpaid · ${unpaidAtRisk}`}
            risk
            active={chip === "unpaid"}
            onClick={() => setChip("unpaid")}
            testid="chip-field-unpaid"
          />
          <Chip
            label="Booted"
            active={chip === "booted"}
            onClick={() => setChip("booted")}
            testid="chip-field-booted"
          />
          <Chip
            label="Released"
            active={chip === "released"}
            onClick={() => setChip("released")}
            testid="chip-field-released"
          />
          <Chip
            label="Paid"
            active={chip === "paid"}
            onClick={() => setChip("paid")}
            testid="chip-field-paid"
          />
        </div>

        {/* List */}
        <div
          className="overflow-hidden rounded-[0.875rem]"
          style={{ background: "#fff", border: `1px solid ${FIELD.line}` }}
          data-testid="field-boot-list"
        >
          {filtered.length === 0 ? (
            <div
              className="px-[13px] py-8 text-center text-[13px]"
              style={{ color: FIELD.ink3 }}
              data-testid="field-boot-empty"
            >
              No vehicles match.
            </div>
          ) : (
            filtered.map(({ boot, status }, i) => (
              <BootRow
                key={boot.id}
                boot={boot}
                status={status}
                last={i === filtered.length - 1}
                canSeeFinancials={canSeeFinancials}
                onClick={() => onOpenBoot(boot)}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function BootRow({
  boot,
  status,
  last,
  canSeeFinancials,
  onClick,
}: {
  boot: Boot;
  status: DerivedStatus;
  last: boolean;
  canSeeFinancials: boolean;
  onClick: () => void;
}) {
  const time = (() => {
    try {
      return format(parseISO(boot.bootedAt), "h:mm a");
    } catch {
      return "";
    }
  })();
  // Meta: color · time (row/space within a lot isn't modeled yet — omit it
  // rather than fake it, per spec).
  const meta = [boot.color, time].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-[11px] px-[13px] py-[13px] text-left"
      style={{
        borderLeft: `3px solid ${status.color}`,
        borderBottom: last ? "none" : `1px solid ${FIELD.line}`,
      }}
      data-testid={`row-field-boot-${boot.id}`}
    >
      <span
        className="min-w-[80px] rounded-md px-2 py-1.5 text-center text-[13.5px] font-bold tracking-[0.05em] text-white"
        style={{
          fontFamily: FIELD_MONO,
          background: "#1a1d24",
          border: "1px solid #333",
        }}
        data-testid={`plate-field-boot-${boot.id}`}
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
          className="rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.02em]"
          style={{ background: status.fill, color: status.color }}
        >
          {status.label}
        </span>
        <span className="mt-[5px] block">
          {canSeeFinancials ? (
            <span
              className="text-[12px] font-semibold"
              style={{ fontFamily: FIELD_MONO, color: FIELD.ink2 }}
            >
              {currency(boot.bootFee ?? 0)}
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

function SectionHeader({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h3
        className="text-[12px] font-bold uppercase tracking-[0.06em]"
        style={{ color: FIELD.ink2 }}
      >
        {title}
      </h3>
      <button
        type="button"
        onClick={onAction}
        className="flex items-center text-[12px] font-semibold"
        style={{ color: FIELD.accent }}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function Kpi({
  value,
  label,
  valueColor,
  alert,
  testid,
}: {
  value: string;
  label: string;
  valueColor?: string;
  alert?: boolean;
  testid: string;
}) {
  return (
    <div
      className="rounded-[0.875rem] px-3.5 py-[13px]"
      style={{
        background: alert ? "#fdecea" : "#fff",
        border: `1px solid ${alert ? "#f5c6c0" : FIELD.line}`,
      }}
      data-testid={testid}
    >
      <div
        className="text-[25px] font-extrabold leading-none tracking-[-0.02em]"
        style={{
          fontFamily: FIELD_MONO,
          color: alert ? "#c0392b" : valueColor ?? FIELD.ink,
        }}
        data-testid={`${testid}-value`}
      >
        {value}
      </div>
      <div
        className="mt-1.5 text-[11.5px] font-semibold"
        style={{ color: alert ? "#a13226" : FIELD.ink2 }}
      >
        {label}
      </div>
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
    style = { background: FIELD.header, color: "#fff", border: `1px solid ${FIELD.header}` };
  } else if (risk) {
    style = { background: "#fdecea", color: "#c0392b", border: "1px solid #f5c6c0" };
  } else {
    style = { background: "#fff", color: FIELD.ink2, border: `1px solid ${FIELD.line}` };
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap rounded-full px-3 py-[7px] text-[12px] font-semibold"
      style={style}
      data-testid={testid}
    >
      {label}
    </button>
  );
}

// Boot glyph matching the mockup's custom icon (lucide has no exact match).
function BootGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className="h-[23px] w-[23px]"
    >
      <path d="M4 4v9a4 4 0 0 0 4 4h6l4 3v-7a3 3 0 0 0-3-3H8" />
      <path d="M4 9h6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// FieldMode — owns the Field Mode nav state and renders the shell + active
// view. Page 1 implements Home; the other tabs and the add/request routes are
// STUB placeholders (local state only) for Pages 2-5 to fill in.
// ---------------------------------------------------------------------------
export function FieldMode({
  userName,
  boots,
  paidCars,
  locations,
  myLocationIds,
  canSeeFinancials,
}: {
  userName: string;
  boots: Boot[];
  paidCars: PaidCarLite[];
  locations: Location[];
  myLocationIds: number[];
  canSeeFinancials: boolean;
}) {
  const [view, setView] = useState<FieldView>("home");

  // Real shift state — the current user's open shift (or null). Drives both the
  // header shift bar and the Shift tab. `refetchInterval` keeps the header label
  // roughly fresh; FieldShift refetches on mutation via invalidateQueries.
  const activeShiftQuery = useQuery<{ shift: Shift | null }>({
    queryKey: ["/api/shifts/active"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/shifts/active");
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const activeShift = activeShiftQuery.data?.shift ?? null;
  const onShift = !!activeShift && !activeShift.checkOutAt;

  // Assigned lot: the attendant's first assigned location (staffLocations →
  // /api/locations/mine). Used to scope all dashboard data.
  const assignedLot = useMemo<Location | null>(() => {
    const id = myLocationIds[0];
    if (id == null) return null;
    return locations.find((l) => l.id === id) ?? null;
  }, [myLocationIds, locations]);

  // Scope boots to the assigned lot + today (local day). Boots with no
  // locationId are excluded (can't attribute them to this lot).
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const todayBoots = useMemo(() => {
    return boots.filter((b) => {
      if (assignedLot == null) return false;
      if (b.locationId !== assignedLot.id) return false;
      try {
        return format(parseISO(b.bootedAt), "yyyy-MM-dd") === todayStr;
      } catch {
        return false;
      }
    });
  }, [boots, assignedLot, todayStr]);

  // Paid plates today (already today-scoped by the caller's paid-cars query,
  // which is keyed to the current filter date).
  const paidPlates = useMemo(
    () =>
      new Set(
        paidCars
          .map((c) => normalizePlate(c.licensePlate))
          .filter(Boolean),
      ),
    [paidCars],
  );
  const paidCount = paidCars.length;

  const homeData: FieldHomeData = {
    todayBoots,
    paidCount,
    paidPlates,
    assignedLot,
    canSeeFinancials,
  };

  // "Add Paid Vehicle" is a full-screen takeover (its own white X-header),
  // rendered ABOVE the shell rather than inside the shell body. Matches the
  // approved page3 mockup. Returning early keeps the tab bar / header hidden.
  if (view === "add") {
    return (
      <FieldAddVehicle
        assignedLot={assignedLot}
        canSeeFinancials={canSeeFinancials}
        onClose={() => setView("home")}
        onViewInventory={() => setView("inventory")}
      />
    );
  }

  // Header shift bar label, derived from real shift state.
  const shiftLabel = onShift
    ? `On shift · since ${shiftStartLabel(activeShift!.checkInAt)}`
    : "Off shift";

  return (
    <FieldShell
      userName={userName}
      lotName={assignedLot?.name ?? "No lot assigned"}
      shift={{ onShift, label: shiftLabel }}
      hasUnread={false}
      active={view}
      onNavigate={setView}
      onOpenFab={() => setView("add")}
      onOpenMenu={() => {
        /* STUB: account/menu sheet — Pages 2-5 */
      }}
      onOpenNotifications={() => {
        /* STUB: notifications — later page */
      }}
    >
      {view === "home" && (
        <FieldHome
          data={homeData}
          onAddPaid={() => setView("add")}
          onRequestBoot={() => setView("request")}
          onSeeInventory={() => setView("inventory")}
          onOpenBoot={() => {
            // Boot detail lives in the Inventory view (Page 4). Tapping a Home
            // activity row jumps there so the attendant can open the detail
            // sheet + quick actions.
            setView("inventory");
          }}
        />
      )}
      {view === "shift" && (
        <FieldShift
          assignedLot={assignedLot}
          activeShift={activeShift}
          onBack={() => setView("home")}
          onShiftChange={() => activeShiftQuery.refetch()}
        />
      )}
      {view === "inventory" && (
        <FieldInventory
          todayBoots={todayBoots}
          paidCars={paidCars}
          assignedLot={assignedLot}
          canSeeFinancials={canSeeFinancials}
          onBack={() => setView("home")}
        />
      )}
      {view !== "home" &&
        view !== "shift" &&
        view !== "inventory" &&
        view !== "add" && (
          <FieldStub view={view} onBack={() => setView("home")} />
        )}
    </FieldShell>
  );
}

// Placeholder body for not-yet-built tabs/routes. Clearly marked as STUB so the
// orchestrator and Pages 2-5 know exactly what to fill in.
function FieldStub({ view, onBack }: { view: FieldView; onBack: () => void }) {
  const labels: Record<FieldView, string> = {
    home: "Home",
    inventory: "Inventory",
    shift: "Shift",
    search: "Search",
    add: "Add Paid Vehicle",
    request: "Request a Boot",
  };
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center"
      data-testid={`field-stub-${view}`}
    >
      <div className="text-[15px] font-bold" style={{ color: FIELD.ink }}>
        {labels[view]}
      </div>
      <div className="text-[13px]" style={{ color: FIELD.ink3 }}>
        Coming soon — wired in a later page.
      </div>
      <button
        type="button"
        onClick={onBack}
        className="mt-2 flex items-center gap-1 text-[13px] font-semibold"
        style={{ color: FIELD.accent }}
        data-testid="button-field-stub-back"
      >
        <ChevronRight className="h-4 w-4 rotate-180" /> Back to Home
      </button>
    </div>
  );
}
