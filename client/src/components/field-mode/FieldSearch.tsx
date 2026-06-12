import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  ChevronLeft,
  Search as SearchIcon,
  CreditCard,
  Plus,
  X,
} from "lucide-react";
import { FIELD, FIELD_MONO } from "./FieldShell";

// ---------------------------------------------------------------------------
// FieldSearch — attendant Search tab (Page bottom-nav "Search"). Lists every
// paid vehicle from /api/paid-cars (Stripe + manual entries) with a search box
// that filters by plate, make/model, or color. This is the searchable view of
// the paid inventory the Stripe integration populates.
//
// Read-only: paid cars are payment records, not booted vehicles with quick
// actions, so there is no detail sheet here (matches the Inventory PaidCarRow).
// ---------------------------------------------------------------------------

type PaidCarLite = {
  id: string;
  makeModel: string;
  color: string;
  licensePlate: string;
  paidAt: string;
  source?: "stripe" | "manual";
};

function normalizePlate(plate: string): string {
  return (plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const PAID = { color: "#1f7a44", fill: "#e4f4ea" };

export function FieldSearch({
  paidCars,
  assignedLot,
  onBack,
}: {
  paidCars: PaidCarLite[];
  assignedLot: { name: string } | null;
  onBack: () => void;
}) {
  const [search, setSearch] = useState("");

  const results = useMemo(() => {
    const q = normalizePlate(search);
    const qText = search.trim().toUpperCase();
    return [...paidCars]
      .filter((c) => {
        if (!q && !qText) return true;
        const plateMatch = normalizePlate(c.licensePlate).includes(q);
        const textMatch =
          (c.makeModel ?? "").toUpperCase().includes(qText) ||
          (c.color ?? "").toUpperCase().includes(qText);
        return plateMatch || textMatch;
      })
      .sort((a, b) => {
        const ta = a.paidAt ? new Date(a.paidAt).getTime() : 0;
        const tb = b.paidAt ? new Date(b.paidAt).getTime() : 0;
        return tb - ta;
      });
  }, [paidCars, search]);

  const hasSearch = search.trim().length > 0;
  const lotName = assignedLot?.name ?? "Your lot";

  const headerCount = hasSearch
    ? `${results.length} result${results.length === 1 ? "" : "s"}`
    : `${paidCars.length} paid`;

  return (
    <div data-testid="field-search">
      {/* Sub-header strip */}
      <div
        className="flex items-center justify-between px-[14px] pb-1 pt-3.5"
        data-testid="search-subheader"
      >
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="flex h-9 w-9 items-center justify-center rounded-full"
            style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
            aria-label="Back to home"
            data-testid="button-search-back"
          >
            <ChevronLeft className="h-5 w-5" style={{ color: FIELD.ink }} />
          </button>
          <div>
            <h2 className="text-[17px] font-extrabold leading-tight" style={{ color: FIELD.ink }}>
              Search paid vehicles
            </h2>
            <div className="text-[12px] font-medium" style={{ color: FIELD.ink3 }}>
              {lotName} · Today
            </div>
          </div>
        </div>
        <div
          className="text-[12px] font-semibold"
          style={{ color: FIELD.ink2 }}
          data-testid="search-count"
        >
          {headerCount}
        </div>
      </div>

      <div className="flex flex-col gap-[13px] px-[14px] pb-[96px] pt-2">
        {/* Search box */}
        <div
          className="flex items-center gap-[9px] rounded-[0.875rem] px-[13px] py-3 text-[13.5px]"
          style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
        >
          <SearchIcon className="h-[17px] w-[17px]" style={{ color: FIELD.ink3 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plate, make, model or color…"
            className="w-full bg-transparent outline-none placeholder:text-[#94a1ad]"
            style={{ color: FIELD.ink }}
            data-testid="input-search-query"
          />
          {search.length > 0 && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              data-testid="button-search-clear"
            >
              <X className="h-4 w-4" style={{ color: FIELD.ink3 }} />
            </button>
          )}
        </div>

        {/* Results or empty state */}
        {results.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 rounded-[0.875rem] px-6 py-12 text-center"
            style={{ background: "#fff", border: `1px solid ${FIELD.line}` }}
            data-testid="search-empty"
          >
            <div
              className="flex h-14 w-14 items-center justify-center rounded-full"
              style={{ background: FIELD.fieldBg }}
            >
              <SearchIcon className="h-7 w-7" style={{ color: FIELD.ink3 }} />
            </div>
            <div className="text-[15px] font-bold" style={{ color: FIELD.ink }}>
              {hasSearch ? "No matching paid vehicles" : "No paid vehicles yet"}
            </div>
            <p className="max-w-[16rem] text-[13px]" style={{ color: FIELD.ink3 }}>
              {hasSearch
                ? "No paid vehicles match your search. Try a different plate or vehicle."
                : "Paid vehicles from Stripe and manual entries will appear here as payments come in."}
            </p>
            {hasSearch && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="mt-1 rounded-[0.875rem] px-5 py-2.5 text-[13px] font-bold"
                style={{
                  background: FIELD.accentSoft,
                  color: FIELD.accentInk,
                  border: "1px solid rgba(31,111,235,0.22)",
                }}
                data-testid="button-search-clear-empty"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <section>
            <h3
              className="mb-2 px-0.5 text-[11px] font-bold uppercase tracking-[0.07em]"
              style={{ color: FIELD.ink3 }}
            >
              {`Paid vehicles · ${results.length}`}
            </h3>
            <div
              className="overflow-y-auto overscroll-contain rounded-[0.875rem]"
              style={{
                background: "#fff",
                border: `1px solid ${FIELD.line}`,
                maxHeight: "22rem",
                WebkitOverflowScrolling: "touch",
              }}
              data-testid="search-results"
            >
              {results.map((c) => (
                <SearchResultRow key={c.id} car={c} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function SearchResultRow({ car }: { car: PaidCarLite }) {
  const isManual = car.source === "manual";
  const meta = [car.color].filter(Boolean).join(" · ");
  let time = "";
  try {
    time = car.paidAt ? format(parseISO(car.paidAt), "h:mm a") : "";
  } catch {
    time = "";
  }
  return (
    <div
      className="flex w-full items-center gap-[11px] px-[13px] py-[13px] text-left"
      style={{
        borderLeft: `3px solid ${PAID.color}`,
        borderBottom: `1px solid ${FIELD.line}`,
      }}
      data-testid={`row-search-${car.id}`}
    >
      <span
        className="min-w-[80px] rounded-md px-2 py-1.5 text-center text-[13.5px] font-bold tracking-[0.05em] text-white"
        style={{
          fontFamily: FIELD_MONO,
          background: "#1a1d24",
          border: "1px solid #333",
        }}
        data-testid={`plate-search-${car.id}`}
      >
        {car.licensePlate || "—"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold" style={{ color: FIELD.ink }}>
          {car.makeModel || "—"}
        </span>
        {meta && (
          <span className="mt-0.5 block text-[11px]" style={{ color: FIELD.ink3 }}>
            {meta}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.02em]"
          style={
            isManual
              ? { background: FIELD.accentSoft, color: FIELD.accentInk }
              : { background: PAID.fill, color: PAID.color }
          }
          data-testid={`source-search-${car.id}`}
        >
          {isManual ? <Plus className="h-3 w-3" /> : <CreditCard className="h-3 w-3" />}
          {isManual ? "Manual" : "Stripe"}
        </span>
        {time && (
          <span
            className="mt-[5px] block text-[12px] font-semibold"
            style={{ fontFamily: FIELD_MONO, color: FIELD.ink2 }}
          >
            {time}
          </span>
        )}
      </span>
    </div>
  );
}
