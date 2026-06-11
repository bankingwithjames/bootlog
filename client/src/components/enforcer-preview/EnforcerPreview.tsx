import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Search as SearchIcon,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Camera,
  X,
  ShieldCheck,
  Clock3,
  CircleDollarSign,
  Wrench,
  ArrowLeft,
  Tag,
  CircleAlert,
  ListChecks,
  Wifi,
  WifiOff,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/components/auth-provider";
import type {
  EnforcementStage,
  EnforcementEvent,
  EvidenceLabel,
} from "@shared/schema";
import { ENFORCEMENT_STAGE_META } from "@shared/schema";
import {
  EnforcerShell,
  ENF,
  ENF_MONO,
  StageBadge,
  PlateText,
  stageColors,
  type EnforcerView,
} from "./EnforcerShell";

// =============================================================================
// Enforcer Mobile Preview — 9-page field experience (preview-only)
// =============================================================================
// Reads live data (boots enriched with derived enforcement stage + Stripe paid
// status) for the signed-in enforcer's lots, and performs real enforcement
// actions through the preview API (which mirrors to the live boot lifecycle).

// ---- Types mirroring the preview API payloads ----
type EnfCase = {
  id: number;
  licensePlate: string;
  makeModel: string;
  color: string | null;
  bootedAt: string;
  bootFee: number;
  amountCollected: number;
  status: string;
  stage: EnforcementStage;
  locationId: number | null;
  photos: string[];
  paidConflict: boolean;
  lastActionByName: string | null;
};

type CasesResponse = { date: string; cases: EnfCase[]; stripeOk: boolean };
type CaseDetailResponse = {
  case: EnfCase;
  events: EnforcementEvent[];
  evidenceLabels: EvidenceLabel[];
};

function currency(n: number): string {
  return (n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function timeLabel(iso: string): string {
  try {
    return format(parseISO(iso), "h:mm a");
  } catch {
    return "";
  }
}
function dateTimeLabel(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d · h:mm a");
  } catch {
    return iso;
  }
}

function todayKey(tzMin: number): string {
  const now = new Date();
  const local = new Date(now.getTime() - tzMin * 60000);
  return local.toISOString().slice(0, 10);
}

// ---- Required-evidence rule per the plan: a boot/active case must have at
// least one photo before it can be marked released or paid. ----
function caseHasEvidence(c: EnfCase): boolean {
  return (c.photos?.length ?? 0) > 0;
}

export function EnforcerPreview() {
  const { user } = useAuth();
  const { toast } = useToast();
  const tzMin = new Date().getTimezoneOffset();
  const date = todayKey(tzMin);

  const [view, setView] = useState<EnforcerView>("home");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  // ---- Live cases for the enforcer's lots ----
  const casesQuery = useQuery<CasesResponse>({
    queryKey: ["/api/preview/enforcer/cases", date],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/preview/enforcer/cases?date=${date}&tz=${tzMin}`,
      ).then((r) => r.json()),
    refetchInterval: 30000,
    // The global client uses staleTime: Infinity, but enforcement data changes
    // as the enforcer acts, so treat preview data as always-fresh-on-refetch.
    staleTime: 0,
  });

  const cases = casesQuery.data?.cases ?? [];
  const stripeOk = casesQuery.data?.stripeOk ?? true;

  // Active = anything not yet resolved (booted family). Resolved = paid/released/
  // completed. Used to split Home + Queue + History.
  const activeCases = useMemo(
    () =>
      cases.filter((c) =>
        ["booted", "payment_pending", "reopened", "review_needed"].includes(
          c.stage,
        ),
      ),
    [cases],
  );
  const resolvedCases = useMemo(
    () =>
      cases.filter((c) =>
        ["paid", "completed", "released", "cancelled"].includes(c.stage),
      ),
    [cases],
  );
  const conflicts = useMemo(
    () => activeCases.filter((c) => c.paidConflict),
    [activeCases],
  );

  function openCase(id: number) {
    setSelectedId(id);
    setView("case");
  }

  // ---- Stage-advance mutation (reused across pages) ----
  const advance = useMutation({
    mutationFn: (vars: {
      id: number;
      stage: EnforcementStage;
      note?: string;
      amountCollected?: number;
      evidenceLabels?: EvidenceLabel[];
    }) =>
      apiRequest(
        "POST",
        `/api/preview/enforcer/case/${vars.id}/action`,
        {
          stage: vars.stage,
          note: vars.note,
          amountCollected: vars.amountCollected,
          evidenceLabels: vars.evidenceLabels,
        },
      ).then((r) => r.json()),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/preview/enforcer/cases"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/preview/enforcer/case", vars.id],
      });
      toast({
        title: "Case updated",
        description: `Moved to "${ENFORCEMENT_STAGE_META[vars.stage].label}".`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't update case",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const userName = user?.name ?? "Enforcer";
  const lotName = "Electric Shuffle"; // single live lot; mirrors attendant mode

  return (
    <>
      <EnforcerShell
        userName={userName}
        lotName={lotName}
        shiftLabel={`${activeCases.length} active`}
        onShift={activeCases.length > 0}
        hasUnread={conflicts.length > 0}
        active={view}
        onNavigate={(v) => {
          setView(v);
          if (v !== "case") setSelectedId(null);
        }}
        onOpenScan={() => setView("lookup")}
        onOpenMenu={() => setMenuOpen(true)}
        onOpenNotifications={() => setView("queue")}
      >
        {!stripeOk && <StaleStripeBanner />}

        {view === "home" && (
          <HomePage
            activeCases={activeCases}
            resolvedToday={resolvedCases}
            conflicts={conflicts}
            loading={casesQuery.isLoading}
            onOpenCase={openCase}
            onGoLookup={() => setView("lookup")}
            onGoQueue={() => setView("queue")}
          />
        )}

        {view === "lookup" && (
          <LookupPage
            query={query}
            setQuery={setQuery}
            cases={cases}
            onOpenCase={openCase}
          />
        )}

        {view === "queue" && (
          <QueuePage
            activeCases={activeCases}
            loading={casesQuery.isLoading}
            onOpenCase={openCase}
          />
        )}

        {view === "history" && (
          <HistoryPage cases={resolvedCases} loading={casesQuery.isLoading} />
        )}

        {view === "case" && selectedId != null && (
          <CaseDetailPage
            caseId={selectedId}
            tzMin={tzMin}
            onBack={() => setView("queue")}
            onAdvance={(vars) => advance.mutate(vars)}
            advancing={advance.isPending}
            onCapture={() => setView("evidence")}
            onVerifyPayment={() => setView("payment")}
          />
        )}

        {view === "evidence" && selectedId != null && (
          <EvidencePage
            caseId={selectedId}
            onBack={() => setView("case")}
            onSave={(labels, note) =>
              advance.mutate(
                {
                  id: selectedId,
                  stage: "booted",
                  note: note || "Evidence captured",
                  evidenceLabels: labels,
                },
                { onSuccess: () => setView("case") },
              )
            }
            saving={advance.isPending}
          />
        )}

        {view === "payment" && selectedId != null && (
          <PaymentPage
            caseId={selectedId}
            onBack={() => setView("case")}
            onConfirm={(amount, note) =>
              advance.mutate(
                {
                  id: selectedId,
                  stage: "paid",
                  amountCollected: amount,
                  note: note || "Payment verified",
                },
                { onSuccess: () => setView("case") },
              )
            }
            confirming={advance.isPending}
          />
        )}
      </EnforcerShell>

      {menuOpen && (
        <ProfileMenu
          userName={userName}
          onClose={() => setMenuOpen(false)}
          onGoProfile={() => {
            setMenuOpen(false);
            setView("profile");
          }}
        />
      )}

      {view === "profile" && (
        <ProfileSheet userName={userName} lotName={lotName} onBack={() => setView("home")} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function StaleStripeBanner() {
  return (
    <div
      className="mx-4 mt-3 flex items-center gap-2 rounded-xl px-3 py-2.5 text-[12.5px] font-semibold"
      style={{ background: ENF.amberSoft, color: ENF.amber }}
      data-testid="banner-stale-stripe"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      Payment data may be stale — couldn't reach Stripe just now.
    </div>
  );
}

// Section header — matches the attendant FieldHome `SectionHeader`: an uppercase
// 12px label on the left and an optional accent "action ›" link on the right.
function SectionTitle({
  children,
  actionLabel,
  onAction,
}: {
  children: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 pb-2.5 pt-4">
      <h2
        className="text-[12px] font-bold uppercase tracking-[0.06em]"
        style={{ color: ENF.ink2 }}
      >
        {children}
      </h2>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="flex items-center text-[12px] font-semibold"
          style={{ color: ENF.accent }}
          data-testid="button-section-action"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// Derived row status → mirrors the attendant `BootRow` treatment: a left-edge
// color stripe + a small status pill. Maps the enforcement stage onto the same
// three council-approved visual states the attendant uses (unpaid / released /
// paid), so a booted/active case reads identically across both apps.
function rowStatus(stage: EnforcementStage): {
  label: string;
  color: string;
  fill: string;
} {
  if (stage === "released")
    return { label: "Released", color: ENF.accentInk, fill: ENF.blueSoft };
  if (stage === "paid" || stage === "completed")
    return { label: "Resolved · Paid", color: ENF.green, fill: ENF.greenSoft };
  if (stage === "cancelled")
    return { label: "Cancelled", color: ENF.gray, fill: ENF.graySoft };
  if (stage === "payment_pending")
    return { label: "Awaiting pay", color: ENF.amber, fill: ENF.amberSoft };
  if (stage === "review_needed")
    return { label: "Review", color: ENF.amber, fill: ENF.amberSoft };
  // booted / reopened / pending_enforcement → active, unpaid, at risk
  return { label: "Booted · Unpaid", color: ENF.red, fill: ENF.redSoft };
}

// CaseCard — reskinned to match the attendant `BootRow`: a dark license-plate
// chip on the left, a 3px colored left-edge status stripe, and a status pill +
// fee stacked on the right. Cards are grouped into a single bordered container
// (see `CaseList`) so consecutive rows share hairline dividers like the
// attendant inventory list.
function CaseCard({
  c,
  onOpen,
  last,
}: {
  c: EnfCase;
  onOpen: (id: number) => void;
  last?: boolean;
}) {
  const status = rowStatus(c.stage);
  const meta = [c.makeModel, c.color, timeLabel(c.bootedAt)]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={() => onOpen(c.id)}
      className="flex w-full items-center gap-[11px] px-[13px] py-[13px] text-left"
      style={{
        borderLeft: `3px solid ${status.color}`,
        borderBottom: last ? "none" : `1px solid ${ENF.line}`,
      }}
      data-testid={`card-case-${c.id}`}
    >
      {/* Dark plate chip — identical treatment to the attendant BootRow */}
      <span
        className="min-w-[84px] rounded-md px-2 py-1.5 text-center text-[14px] font-bold uppercase tracking-[0.06em] text-white"
        style={{ fontFamily: ENF_MONO, background: "#1a1d24", border: "1px solid #333" }}
        data-testid={`plate-${c.id}`}
      >
        {c.licensePlate}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="block truncate text-[13px] font-semibold" style={{ color: ENF.ink }}>
            {c.makeModel}
          </span>
          {c.paidConflict && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase"
              style={{ background: ENF.greenSoft, color: ENF.green }}
              data-testid={`badge-paid-conflict-${c.id}`}
            >
              <CircleAlert className="h-3 w-3" />
              Paid?
            </span>
          )}
        </span>
        {meta && (
          <span className="mt-0.5 block truncate text-[11px]" style={{ color: ENF.ink3 }}>
            {[c.color, timeLabel(c.bootedAt)].filter(Boolean).join(" · ")}
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
        <span className="mt-[5px] block text-[12px] font-semibold" style={{ fontFamily: ENF_MONO, color: ENF.ink2 }}>
          {currency(c.bootFee)}
        </span>
      </span>
    </button>
  );
}

// Grouped list container — wraps CaseCards in a single bordered, rounded box
// with shared dividers, matching the attendant inventory list shell.
function CaseList({
  cases,
  onOpenCase,
  testid,
}: {
  cases: EnfCase[];
  onOpenCase: (id: number) => void;
  testid?: string;
}) {
  return (
    <div className="px-4">
      <div
        className="overflow-hidden rounded-[0.875rem]"
        style={{ background: "#fff", border: `1px solid ${ENF.line}` }}
        data-testid={testid}
      >
        {cases.map((c, i) => (
          <CaseCard
            key={c.id}
            c={c}
            onOpen={onOpenCase}
            last={i === cases.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyState({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div
        className="flex h-14 w-14 items-center justify-center rounded-[0.875rem]"
        style={{ background: ENF.graySoft, color: ENF.ink3 }}
      >
        {icon}
      </div>
      <div className="text-[15px] font-bold" style={{ color: ENF.ink }}>
        {title}
      </div>
      <div className="max-w-[16rem] text-[13px]" style={{ color: ENF.ink2 }}>
        {sub}
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="space-y-2.5 px-4">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[68px] animate-pulse rounded-[0.875rem] bg-white"
          style={{ border: `1px solid ${ENF.line}` }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 1 — Home
// ---------------------------------------------------------------------------
function HomePage({
  activeCases,
  resolvedToday,
  conflicts,
  loading,
  onOpenCase,
  onGoLookup,
  onGoQueue,
}: {
  activeCases: EnfCase[];
  resolvedToday: EnfCase[];
  conflicts: EnfCase[];
  loading: boolean;
  onOpenCase: (id: number) => void;
  onGoLookup: () => void;
  onGoQueue: () => void;
}) {
  const collected = resolvedToday.reduce((s, c) => s + (c.amountCollected || 0), 0);

  // Filter-chip row — mirrors the attendant inventory filter chips. Filters the
  // "Active enforcement" list shown on Home.
  type HomeFilter = "all" | "booted" | "awaiting" | "released" | "paid";
  const [filter, setFilter] = useState<HomeFilter>("all");
  const filtered = activeCases.filter((c) => {
    if (filter === "all") return true;
    if (filter === "booted")
      return ["booted", "reopened", "pending_enforcement"].includes(c.stage);
    if (filter === "awaiting")
      return ["payment_pending", "review_needed"].includes(c.stage);
    if (filter === "released") return c.stage === "released";
    if (filter === "paid") return ["paid", "completed"].includes(c.stage);
    return true;
  });
  const chips: { key: HomeFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "booted", label: "Booted" },
    { key: "awaiting", label: "Awaiting" },
    { key: "released", label: "Released" },
    { key: "paid", label: "Paid" },
  ];

  return (
    <div className="pb-6" data-testid="page-enforcer-home">
      {/* KPI strip — attendant-style white tiles, mono values; Needs review uses
          the soft-red alert variant when there are conflicts. */}
      <div className="grid grid-cols-2 gap-2.5 px-4 pt-4">
        <Kpi label="Active boots" value={String(activeCases.length)} testid="kpi-active" />
        <Kpi
          label="Resolved today"
          value={String(resolvedToday.length)}
          valueColor={ENF.green}
          testid="kpi-resolved"
        />
        <Kpi
          label="Collected today"
          value={currency(collected)}
          valueColor={ENF.green}
          testid="kpi-collected"
        />
        <Kpi
          label="Needs review"
          value={String(conflicts.length)}
          alert={conflicts.length > 0}
          testid="kpi-review"
        />
      </div>

      {/* Two-tile action row — matches the attendant: an orange primary tile and
          a soft-blue secondary tile, each with icon + label + subtext. */}
      <div className="grid grid-cols-2 gap-[11px] px-4 pt-4">
        <button
          type="button"
          onClick={onGoLookup}
          className="flex flex-col gap-2 rounded-[0.875rem] px-3.5 py-[15px] text-left text-sm font-bold text-white"
          style={{ background: ENF.orange }}
          data-testid="button-home-lookup"
        >
          <SearchIcon className="h-[23px] w-[23px]" />
          <span>Look up a plate</span>
          <span className="text-[11px] font-medium opacity-85">Check payment status</span>
        </button>
        <button
          type="button"
          onClick={onGoQueue}
          className="flex flex-col gap-2 rounded-[0.875rem] px-3.5 py-[15px] text-left text-sm font-bold"
          style={{
            background: ENF.blueSoft,
            color: ENF.accentInk,
            border: "1px solid rgba(31,111,235,0.22)",
          }}
          data-testid="button-home-view-queue"
        >
          <ListChecks className="h-[23px] w-[23px]" />
          <span>Enforcement queue</span>
          <span className="text-[11px] font-medium opacity-85">View all active</span>
        </button>
      </div>

      {conflicts.length > 0 && (
        <>
          <SectionTitle>Needs review</SectionTitle>
          <CaseList cases={conflicts} onOpenCase={onOpenCase} testid="list-needs-review" />
        </>
      )}

      <SectionTitle actionLabel="View queue ›" onAction={onGoQueue}>
        Active enforcement
      </SectionTitle>

      {/* Filter chips */}
      <div className="flex gap-2 overflow-x-auto px-4 pb-3" data-testid="home-filter-chips">
        {chips.map((ch) => (
          <Chip
            key={ch.key}
            label={ch.label}
            active={filter === ch.key}
            risk={ch.key === "booted"}
            onClick={() => setFilter(ch.key)}
            testid={`chip-${ch.key}`}
          />
        ))}
      </div>

      {loading ? (
        <CardSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-7 w-7" />}
          title={filter === "all" ? "No active boots" : "Nothing in this filter"}
          sub={
            filter === "all"
              ? "When you place a boot or one needs attention, it'll show up here."
              : "Try a different filter to see other cases."
          }
        />
      ) : (
        <CaseList
          cases={filtered.slice(0, 8)}
          onOpenCase={onOpenCase}
          testid="list-active-enforcement"
        />
      )}
    </div>
  );
}

// Kpi — matches the attendant FieldHome `Kpi`: a white tile with a thin border
// and a mono 25px extrabold value. The "alert" variant (used for Needs review
// when count > 0) swaps to a soft-red tile with red value + label, exactly like
// the attendant's risk KPI.
function Kpi({
  label,
  value,
  valueColor,
  alert,
  testid,
}: {
  label: string;
  value: string;
  valueColor?: string;
  alert?: boolean;
  testid: string;
}) {
  return (
    <div
      className="rounded-[0.875rem] px-3.5 py-[13px]"
      style={{
        background: alert ? "#fdecea" : "#fff",
        border: `1px solid ${alert ? "#f5c6c0" : ENF.line}`,
      }}
      data-testid={testid}
    >
      <div
        className="text-[25px] font-extrabold leading-none tracking-[-0.02em]"
        style={{
          fontFamily: ENF_MONO,
          color: alert ? "#c0392b" : valueColor ?? ENF.ink,
        }}
        data-testid={`${testid}-value`}
      >
        {value}
      </div>
      <div
        className="mt-1.5 text-[11.5px] font-semibold"
        style={{ color: alert ? "#a13226" : ENF.ink2 }}
      >
        {label}
      </div>
    </div>
  );
}

// Chip — mirrors the attendant FieldHome `Chip`: a pill filter with a dark
// active state (header navy), a soft-red "risk" variant, and a neutral white
// default. Used for the Home filter-chip row.
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
    style = { background: ENF.header, color: "#fff", border: `1px solid ${ENF.header}` };
  } else if (risk) {
    style = { background: "#fdecea", color: "#c0392b", border: "1px solid #f5c6c0" };
  } else {
    style = { background: "#fff", color: ENF.ink2, border: `1px solid ${ENF.line}` };
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

// ---------------------------------------------------------------------------
// Page 2 — Plate Lookup / Verification
// ---------------------------------------------------------------------------
function LookupPage({
  query,
  setQuery,
  cases,
  onOpenCase,
}: {
  query: string;
  setQuery: (v: string) => void;
  cases: EnfCase[];
  onOpenCase: (id: number) => void;
}) {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const q = norm(query);
  const matches = q
    ? cases.filter(
        (c) => norm(c.licensePlate).includes(q) || c.makeModel.toUpperCase().includes(query.toUpperCase()),
      )
    : [];
  const exact = q ? cases.find((c) => norm(c.licensePlate) === q) : undefined;

  return (
    <div className="pb-6" data-testid="page-enforcer-lookup">
      {/* Sticky search — wrapper matches the now-white body; the input itself is
          a recessed off-white field, matching the attendant search treatment. */}
      <div
        className="sticky top-0 z-[5] px-4 pb-3 pt-4"
        style={{ background: "#fff" }}
      >
        <div
          className="flex items-center gap-2 rounded-[0.875rem] px-3.5 py-3"
          style={{ background: ENF.fieldBg, border: `1px solid ${ENF.line}` }}
        >
          <SearchIcon className="h-[18px] w-[18px]" style={{ color: ENF.ink3 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter or scan a plate"
            autoCapitalize="characters"
            className="flex-1 bg-transparent text-[17px] font-bold uppercase outline-none"
            style={{ fontFamily: ENF_MONO, letterSpacing: "0.06em", color: ENF.ink }}
            data-testid="input-lookup-plate"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear"
              data-testid="button-lookup-clear"
            >
              <X className="h-[18px] w-[18px]" style={{ color: ENF.ink3 }} />
            </button>
          )}
        </div>
      </div>

      {/* Verification result for an exact match */}
      {exact && (
        <div className="px-4 pb-2">
          <VerificationCard c={exact} onOpen={onOpenCase} />
        </div>
      )}

      {!query && (
        <EmptyState
          icon={<SearchIcon className="h-7 w-7" />}
          title="Look up a vehicle"
          sub="Type a plate to check its payment + enforcement status before you act."
        />
      )}

      {query && matches.length === 0 && (
        <div className="px-4">
          <div
            className="rounded-[0.875rem] bg-white px-4 py-5 text-center"
            style={{ border: `1px solid ${ENF.line}` }}
            data-testid="lookup-no-match"
          >
            <div className="text-[15px] font-bold" style={{ color: ENF.ink }}>
              No active case for that plate
            </div>
            <div className="mt-1 text-[13px]" style={{ color: ENF.ink2 }}>
              No boot or open case found for{" "}
              <span style={{ fontFamily: ENF_MONO }}>{query.toUpperCase()}</span> today.
            </div>
          </div>
        </div>
      )}

      {query && matches.length > 0 && (
        <>
          <SectionTitle>Matches</SectionTitle>
          <CaseList cases={matches} onOpenCase={onOpenCase} testid="list-lookup-matches" />
        </>
      )}
    </div>
  );
}

function VerificationCard({ c, onOpen }: { c: EnfCase; onOpen: (id: number) => void }) {
  const paid = ["paid", "completed"].includes(c.stage) || c.paidConflict;
  const fg = paid ? ENF.green : ENF.red;
  const bg = paid ? ENF.greenSoft : ENF.redSoft;
  return (
    <div
      className="rounded-[0.875rem] p-4"
      style={{ background: bg, border: `1px solid ${fg}22` }}
      data-testid="verification-card"
    >
      <div className="flex items-center justify-between">
        <PlateText plate={c.licensePlate} size={22} />
        <StageBadge stage={c.stage} />
      </div>
      <div
        className="mt-2 flex items-center gap-2 text-[14px] font-bold"
        style={{ color: fg }}
      >
        {paid ? (
          <>
            <CheckCircle2 className="h-[18px] w-[18px]" />
            {c.paidConflict ? "Appears PAID — do not boot" : "Paid"}
          </>
        ) : (
          <>
            <AlertTriangle className="h-[18px] w-[18px]" />
            Unpaid — enforcement may apply
          </>
        )}
      </div>
      <div className="mt-1 text-[13px]" style={{ color: ENF.ink2 }}>
        {c.makeModel}
        {c.color ? ` · ${c.color}` : ""} · {currency(c.bootFee)} fee
      </div>
      <button
        type="button"
        onClick={() => onOpen(c.id)}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-white py-2.5 text-[14px] font-bold"
        style={{ color: ENF.ink, border: `1px solid ${ENF.line}` }}
        data-testid="button-open-from-verification"
      >
        Open case
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 3 — Enforcement Queue
// ---------------------------------------------------------------------------
function QueuePage({
  activeCases,
  loading,
  onOpenCase,
}: {
  activeCases: EnfCase[];
  loading: boolean;
  onOpenCase: (id: number) => void;
}) {
  return (
    <div className="pb-6" data-testid="page-enforcer-queue">
      <SectionTitle>Enforcement queue · {activeCases.length}</SectionTitle>
      {loading ? (
        <CardSkeleton />
      ) : activeCases.length === 0 ? (
        <EmptyState
          icon={<ListChecksIcon />}
          title="Queue is clear"
          sub="No active boots or pending actions right now."
        />
      ) : (
        <CaseList cases={activeCases} onOpenCase={onOpenCase} testid="list-queue" />
      )}
    </div>
  );
}

function ListChecksIcon() {
  return <ShieldCheck className="h-7 w-7" />;
}

// ---------------------------------------------------------------------------
// Page 4 — Case Detail (with audit timeline + actions)
// ---------------------------------------------------------------------------
function CaseDetailPage({
  caseId,
  tzMin,
  onBack,
  onAdvance,
  advancing,
  onCapture,
  onVerifyPayment,
}: {
  caseId: number;
  tzMin: number;
  onBack: () => void;
  onAdvance: (vars: {
    id: number;
    stage: EnforcementStage;
    note?: string;
    amountCollected?: number;
  }) => void;
  advancing: boolean;
  onCapture: () => void;
  onVerifyPayment: () => void;
}) {
  const detail = useQuery<CaseDetailResponse>({
    queryKey: ["/api/preview/enforcer/case", caseId],
    queryFn: () =>
      apiRequest("GET", `/api/preview/enforcer/case/${caseId}`).then((r) => r.json()),
    // Enforcement state changes as the enforcer acts; the global client defaults
    // to staleTime: Infinity, so opt this view into refetch-on-invalidate.
    staleTime: 0,
  });
  const c = detail.data?.case;
  const events = detail.data?.events ?? [];
  const evidence = detail.data?.evidenceLabels ?? [];

  if (detail.isLoading || !c) {
    return (
      <div className="px-4 pt-4">
        <div className="h-[180px] animate-pulse rounded-[0.875rem] bg-white" style={{ border: `1px solid ${ENF.line}` }} />
      </div>
    );
  }

  const isActive = ["booted", "payment_pending", "reopened", "review_needed"].includes(c.stage);
  const resolved = ["paid", "completed", "released"].includes(c.stage);
  const hasEvidence = caseHasEvidence(c) || evidence.length > 0;

  return (
    <div className="pb-8" data-testid="page-enforcer-case">
      <div className="px-4 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-bold"
          style={{ color: ENF.accent }}
          data-testid="button-case-back"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to queue
        </button>
      </div>

      {/* Header card */}
      <div className="px-4 pt-3">
        <div
          className="rounded-[0.875rem] bg-white p-4"
          style={{ border: `1px solid ${ENF.line}` }}
        >
          <div className="flex items-start justify-between">
            <PlateText plate={c.licensePlate} size={22} testid="case-plate" />
            <StageBadge stage={c.stage} testid="case-stage" />
          </div>
          <div className="mt-1.5 text-[13.5px] font-medium" style={{ color: ENF.ink2 }}>
            {c.makeModel}
            {c.color ? ` · ${c.color}` : ""}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label="Boot fee" value={currency(c.bootFee)} />
            <Stat label="Collected" value={currency(c.amountCollected)} />
            <Stat label="Booted" value={dateTimeLabel(c.bootedAt)} />
            <Stat label="Photos" value={String(c.photos?.length ?? 0)} />
          </div>

          {c.paidConflict && (
            <div
              className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px] font-semibold"
              style={{ background: ENF.greenSoft, color: ENF.green }}
              data-testid="case-paid-warning"
            >
              <CircleAlert className="mt-px h-4 w-4 shrink-0" />
              This plate appears to have paid today. Verify payment before
              keeping the boot on.
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      {isActive && (
        <div className="space-y-2.5 px-4 pt-4">
          <ActionButton
            icon={<Camera className="h-[18px] w-[18px]" />}
            label="Capture / label evidence"
            onClick={onCapture}
            testid="button-action-evidence"
          />
          <ActionButton
            icon={<CircleDollarSign className="h-[18px] w-[18px]" />}
            label="Verify payment / collect"
            tone="primary"
            onClick={onVerifyPayment}
            disabled={advancing}
            testid="button-action-verify"
          />
          {c.stage !== "payment_pending" && (
            <ActionButton
              icon={<Clock3 className="h-[18px] w-[18px]" />}
              label="Mark awaiting payment"
              onClick={() => onAdvance({ id: c.id, stage: "payment_pending", note: "Awaiting payment" })}
              disabled={advancing}
              testid="button-action-await"
            />
          )}
          <ReleaseButton
            disabled={advancing || !hasEvidence}
            blockedReason={!hasEvidence ? "Add at least one evidence photo before releasing." : undefined}
            onClick={() => onAdvance({ id: c.id, stage: "released", note: "Boot released" })}
          />
        </div>
      )}

      {resolved && (
        <div className="space-y-2.5 px-4 pt-4">
          <ActionButton
            icon={<Wrench className="h-[18px] w-[18px]" />}
            label="Reopen case"
            onClick={() => onAdvance({ id: c.id, stage: "reopened", note: "Case reopened" })}
            disabled={advancing}
            testid="button-action-reopen"
          />
        </div>
      )}

      {/* Evidence labels */}
      {evidence.length > 0 && (
        <>
          <SectionTitle>Evidence</SectionTitle>
          <div className="flex flex-wrap gap-2 px-4">
            {evidence.map((e, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                style={{ background: ENF.blueSoft, color: ENF.blue }}
                data-testid={`evidence-label-${i}`}
              >
                <Tag className="h-3 w-3" />
                {e.label}
              </span>
            ))}
          </div>
        </>
      )}

      {/* Audit timeline */}
      <SectionTitle>Timeline</SectionTitle>
      <div className="px-4">
        {events.length === 0 ? (
          <div className="text-[13px]" style={{ color: ENF.ink3 }}>
            No enforcement actions recorded yet.
          </div>
        ) : (
          <ol className="space-y-3" data-testid="case-timeline">
            {events.map((ev) => {
              const { fg } = stageColors(ev.stage as EnforcementStage);
              return (
                <li key={ev.id} className="flex gap-3">
                  <span
                    className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: fg }}
                  />
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-bold" style={{ color: ENF.ink }}>
                      {ENFORCEMENT_STAGE_META[ev.stage as EnforcementStage]?.label ?? ev.stage}
                    </div>
                    <div className="text-[12px]" style={{ color: ENF.ink2 }}>
                      {ev.actorName ?? "System"} · {dateTimeLabel(ev.createdAt)}
                    </div>
                    {ev.note && (
                      <div className="mt-0.5 text-[12.5px]" style={{ color: ENF.ink2 }}>
                        {ev.note}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: ENF.ink3 }}>
        {label}
      </div>
      <div className="text-[14px] font-bold" style={{ color: ENF.ink }}>
        {value}
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  tone = "default",
  disabled,
  testid,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "default" | "primary";
  disabled?: boolean;
  testid: string;
}) {
  const primary = tone === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 rounded-[0.875rem] px-4 py-3.5 text-[15px] font-bold disabled:opacity-50"
      style={
        primary
          ? { background: ENF.orange, color: "#fff", boxShadow: "0 4px 14px rgba(232,86,10,.3)" }
          : { background: "#fff", color: ENF.ink, border: `1px solid ${ENF.line}` }
      }
      data-testid={testid}
    >
      {icon}
      {label}
    </button>
  );
}

function ReleaseButton({
  onClick,
  disabled,
  blockedReason,
}: {
  onClick: () => void;
  disabled?: boolean;
  blockedReason?: string;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex w-full items-center gap-2.5 rounded-[0.875rem] px-4 py-3.5 text-[15px] font-bold disabled:opacity-50"
        style={{ background: "#fff", color: ENF.red, border: `1px solid ${ENF.red}33` }}
        data-testid="button-action-release"
      >
        <ShieldCheck className="h-[18px] w-[18px]" />
        Release boot (no fee)
      </button>
      {blockedReason && (
        <div className="mt-1.5 flex items-center gap-1.5 px-1 text-[12px] font-semibold" style={{ color: ENF.amber }}>
          <AlertTriangle className="h-3.5 w-3.5" />
          {blockedReason}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 5 — Evidence Capture
// ---------------------------------------------------------------------------
const EVIDENCE_PRESETS = [
  "Plate close-up",
  "Boot installed",
  "Parking violation",
  "Vehicle wide shot",
  "Permit / signage",
];

function EvidencePage({
  caseId,
  onBack,
  onSave,
  saving,
}: {
  caseId: number;
  onBack: () => void;
  onSave: (labels: EvidenceLabel[], note: string) => void;
  saving: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");

  function toggle(label: string) {
    setSelected((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );
  }

  return (
    <div className="pb-8" data-testid="page-enforcer-evidence">
      <div className="px-4 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-bold"
          style={{ color: ENF.accent }}
          data-testid="button-evidence-back"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to case
        </button>
      </div>

      <div className="px-4 pt-3">
        <div
          className="flex flex-col items-center gap-2 rounded-[0.875rem] border-2 border-dashed py-10"
          style={{ borderColor: ENF.line, background: "#fff" }}
          data-testid="evidence-capture-placeholder"
        >
          <Camera className="h-9 w-9" style={{ color: ENF.ink3 }} />
          <div className="text-[14px] font-bold" style={{ color: ENF.ink }}>
            Capture photo
          </div>
          <div className="px-8 text-center text-[12.5px]" style={{ color: ENF.ink2 }}>
            In the field, this opens the camera. Tag each shot below so disputes
            are easy to defend.
          </div>
        </div>
      </div>

      <SectionTitle>Tag this evidence</SectionTitle>
      <div className="flex flex-wrap gap-2 px-4">
        {EVIDENCE_PRESETS.map((label) => {
          const on = selected.includes(label);
          return (
            <button
              key={label}
              type="button"
              onClick={() => toggle(label)}
              className="rounded-full px-3 py-2 text-[12.5px] font-semibold"
              style={
                on
                  ? { background: ENF.accent, color: "#fff" }
                  : { background: "#fff", color: ENF.ink2, border: `1px solid ${ENF.line}` }
              }
              data-testid={`evidence-preset-${label.replace(/[^a-z]/gi, "-").toLowerCase()}`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <SectionTitle>Note (optional)</SectionTitle>
      <div className="px-4">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="e.g. Parked in fire lane, no permit displayed"
          className="w-full rounded-[0.875rem] bg-white px-3.5 py-3 text-[14px] outline-none"
          style={{ border: `1px solid ${ENF.line}`, color: ENF.ink }}
          data-testid="textarea-evidence-note"
        />
      </div>

      <div className="px-4 pt-4">
        <button
          type="button"
          disabled={saving || selected.length === 0}
          onClick={() =>
            onSave(
              selected.map((label) => ({ label })),
              note,
            )
          }
          className="flex w-full items-center justify-center gap-2 rounded-[0.875rem] py-3.5 text-[15px] font-bold text-white disabled:opacity-50"
          style={{ background: ENF.orange }}
          data-testid="button-evidence-save"
        >
          <Tag className="h-[18px] w-[18px]" />
          Save evidence
        </button>
        {selected.length === 0 && (
          <div className="mt-1.5 px-1 text-[12px] font-semibold" style={{ color: ENF.amber }}>
            Pick at least one tag to save.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 6 — Payment Verification / Release
// ---------------------------------------------------------------------------
function PaymentPage({
  caseId,
  onBack,
  onConfirm,
  confirming,
}: {
  caseId: number;
  onBack: () => void;
  onConfirm: (amount: number, note: string) => void;
  confirming: boolean;
}) {
  const detail = useQuery<CaseDetailResponse>({
    queryKey: ["/api/preview/enforcer/case", caseId],
    queryFn: () =>
      apiRequest("GET", `/api/preview/enforcer/case/${caseId}`).then((r) => r.json()),
    // Enforcement state changes as the enforcer acts; the global client defaults
    // to staleTime: Infinity, so opt this view into refetch-on-invalidate.
    staleTime: 0,
  });
  const c = detail.data?.case;
  const fee = c?.bootFee ?? 0;
  const [amount, setAmount] = useState<string>("");
  const [method, setMethod] = useState<"card" | "cash" | "app">("card");

  const amt = amount === "" ? fee : Number(amount);
  const partial = amt > 0 && amt < fee;

  return (
    <div className="pb-8" data-testid="page-enforcer-payment">
      <div className="px-4 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-bold"
          style={{ color: ENF.accent }}
          data-testid="button-payment-back"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to case
        </button>
      </div>

      <div className="px-4 pt-3">
        <div className="rounded-[0.875rem] bg-white p-4" style={{ border: `1px solid ${ENF.line}` }}>
          {c && (
            <div className="flex items-center justify-between pb-3">
              <PlateText plate={c.licensePlate} size={20} />
              <span className="text-[13px] font-bold" style={{ color: ENF.ink2 }}>
                Fee {currency(fee)}
              </span>
            </div>
          )}

          <label className="text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: ENF.ink3 }}>
            Amount collected
          </label>
          <div
            className="mt-1.5 flex items-center gap-2 rounded-xl px-3.5 py-3"
            style={{ border: `1px solid ${ENF.line}` }}
          >
            <span className="text-[18px] font-bold" style={{ color: ENF.ink3 }}>$</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder={String(fee)}
              className="flex-1 bg-transparent text-[18px] font-bold outline-none"
              style={{ color: ENF.ink }}
              data-testid="input-payment-amount"
            />
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {(["card", "cash", "app"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className="rounded-xl py-2.5 text-[13px] font-bold capitalize"
                style={
                  method === m
                    ? { background: ENF.accent, color: "#fff" }
                    : { background: "#fff", color: ENF.ink2, border: `1px solid ${ENF.line}` }
                }
                data-testid={`button-method-${m}`}
              >
                {m}
              </button>
            ))}
          </div>

          {partial && (
            <div
              className="mt-3 flex items-center gap-2 rounded-xl px-3 py-2.5 text-[12.5px] font-semibold"
              style={{ background: ENF.amberSoft, color: ENF.amber }}
              data-testid="payment-partial-warning"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Partial payment — case will be marked settled, not fully paid.
            </div>
          )}
        </div>
      </div>

      <div className="px-4 pt-4">
        <button
          type="button"
          disabled={confirming || amt <= 0}
          onClick={() => onConfirm(amt, `Collected ${currency(amt)} via ${method}`)}
          className="flex w-full items-center justify-center gap-2 rounded-[0.875rem] py-3.5 text-[15px] font-bold text-white disabled:opacity-50"
          style={{ background: ENF.green }}
          data-testid="button-payment-confirm"
        >
          <CheckCircle2 className="h-[18px] w-[18px]" />
          Confirm payment & resolve
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 7 — History (resolved cases)
// ---------------------------------------------------------------------------
function HistoryPage({ cases, loading }: { cases: EnfCase[]; loading: boolean }) {
  const collected = cases.reduce((s, c) => s + (c.amountCollected || 0), 0);
  return (
    <div className="pb-6" data-testid="page-enforcer-history">
      <div className="px-4 pt-4">
        <div
          className="rounded-[0.875rem] bg-white px-4 py-3"
          style={{ border: `1px solid ${ENF.line}` }}
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: ENF.ink3 }}>
            Resolved today
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-[24px] font-extrabold" style={{ color: ENF.green }}>
              {currency(collected)}
            </span>
            <span className="text-[13px] font-semibold" style={{ color: ENF.ink2 }}>
              {cases.length} case{cases.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </div>
      <SectionTitle>Resolved cases</SectionTitle>
      {loading ? (
        <CardSkeleton />
      ) : cases.length === 0 ? (
        <EmptyState
          icon={<Clock3 className="h-7 w-7" />}
          title="Nothing resolved yet"
          sub="Paid and released cases from today will appear here."
        />
      ) : (
        <CaseList cases={cases} onOpenCase={() => {}} testid="list-history" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 8/9 — Profile menu + sheet
// ---------------------------------------------------------------------------
function ProfileMenu({
  userName,
  onClose,
  onGoProfile,
}: {
  userName: string;
  onClose: () => void;
  onGoProfile: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-end"
      style={{ background: "rgba(13,27,42,.45)" }}
      onClick={onClose}
      data-testid="enforcer-menu-overlay"
    >
      <div
        className="w-full rounded-t-3xl bg-white p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full" style={{ background: ENF.line }} />
        <div className="text-[16px] font-bold" style={{ color: ENF.ink }}>
          {userName}
        </div>
        <div className="text-[13px]" style={{ color: ENF.ink2 }}>
          Enforcer · Preview build
        </div>
        <button
          type="button"
          onClick={onGoProfile}
          className="mt-4 flex w-full items-center justify-between rounded-[0.875rem] px-4 py-3.5 text-[15px] font-bold"
          style={{ background: ENF.fieldBg, color: ENF.ink }}
          data-testid="button-menu-profile"
        >
          Profile & settings
          <ChevronRight className="h-4 w-4" style={{ color: ENF.ink3 }} />
        </button>
      </div>
    </div>
  );
}

function ProfileSheet({
  userName,
  lotName,
  onBack,
}: {
  userName: string;
  lotName: string;
  onBack: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 bg-white" data-testid="page-enforcer-profile">
      <div
        className="px-4 pb-5 pt-5 text-white"
        style={{ background: `linear-gradient(160deg, ${ENF.header}, ${ENF.header2})` }}
      >
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-bold text-white/90"
          data-testid="button-profile-back"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <div className="mt-3 text-[20px] font-extrabold">{userName}</div>
        <div className="text-[13px] text-white/70">Enforcer</div>
      </div>
      <div className="space-y-2.5 p-4">
        <ProfileRow label="Assigned lot" value={lotName} />
        <ProfileRow label="Role" value="Enforcer" />
        <ProfileRow label="Build" value="Mobile field preview" />
        <div
          className="flex items-center gap-2 rounded-[0.875rem] px-4 py-3 text-[12.5px] font-semibold"
          style={{ background: ENF.blueSoft, color: ENF.blue }}
        >
          <Wifi className="h-4 w-4" />
          Live data — actions update real cases.
        </div>
      </div>
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-center justify-between rounded-[0.875rem] bg-white px-4 py-3.5"
      style={{ border: `1px solid ${ENF.line}` }}
    >
      <span className="text-[13px] font-semibold" style={{ color: ENF.ink2 }}>
        {label}
      </span>
      <span className="text-[14px] font-bold" style={{ color: ENF.ink }}>
        {value}
      </span>
    </div>
  );
}
