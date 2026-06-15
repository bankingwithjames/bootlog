import { useMemo, useRef, useState } from "react";
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
  Eye,
  EyeOff,
  Plus,
  Car,
  LogOut,
  LayoutDashboard,
  Monitor,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/components/auth-provider";
import type {
  EnforcementStage,
  EnforcementEvent,
  EvidenceLabel,
  BootRequest,
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

// A car paid today (Stripe + manual), mirroring /api/paid-cars. Surfaced in the
// History tab as "Active paid cars today" so the enforcer can see the day's
// payments regardless of boot/lot state.
type PaidCarLite = {
  id: string;
  licensePlate: string;
  makeModel: string;
  color: string | null;
  paidAt: string;
  source?: "stripe" | "manual";
};
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

// Local (tz-shifted) YYYY-MM-DD for an ISO instant. Used to decide whether a
// case belongs to "today" so History + the day KPIs only count today's work.
function localDayKey(iso: string, tzMin: number): string {
  try {
    const local = new Date(parseISO(iso).getTime() - tzMin * 60000);
    return local.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

// ---- Required-evidence rule per the plan: a boot/active case must have at
// least one photo before it can be marked released or paid. ----
function caseHasEvidence(c: EnfCase): boolean {
  return (c.photos?.length ?? 0) > 0;
}

export function EnforcerPreview() {
  const { user, logout, isAdmin } = useAuth();
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

  // ---- Cars paid TODAY (Stripe + manual) for the History tab. Independent of
  // boot/lot state, so it shows the day's payments even when no boot exists. ----
  const paidCarsQuery = useQuery<{ cars: PaidCarLite[]; source: string }>({
    queryKey: ["/api/paid-cars", date, tzMin],
    queryFn: () =>
      apiRequest("GET", `/api/paid-cars?date=${date}&tz=${tzMin}`).then((r) =>
        r.json(),
      ),
    refetchInterval: 30000,
    staleTime: 0,
  });
  const paidCarsToday = useMemo<PaidCarLite[]>(
    () =>
      [...(paidCarsQuery.data?.cars ?? [])].sort((a, b) => {
        const ta = a.paidAt ? new Date(a.paidAt).getTime() : 0;
        const tb = b.paidAt ? new Date(b.paidAt).getTime() : 0;
        return tb - ta;
      }),
    [paidCarsQuery.data],
  );

  // ---- Paid cars across the trailing 30 days (Stripe + manual). Powers the
  // Lookup page so a plate can be matched against a month of payment history,
  // not just today. Independent of any boot/lot state. ----
  const paidCarsRangeQuery = useQuery<{
    cars: PaidCarLite[];
    days: number;
    stripeOk: boolean;
  }>({
    queryKey: ["/api/preview/enforcer/paid-cars-range", tzMin],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/preview/enforcer/paid-cars-range?days=30&tz=${tzMin}`,
      ).then((r) => r.json()),
    refetchInterval: 60000,
    staleTime: 0,
  });
  const paidCars30d = useMemo<PaidCarLite[]>(
    () => paidCarsRangeQuery.data?.cars ?? [],
    [paidCarsRangeQuery.data],
  );

  // ---- Pending boot requests (from admin/attendant) awaiting an enforcer to
  // initiate or dismiss. This is what links a requested boot to chop1's queue. ----
  const bootRequestsQuery = useQuery<BootRequest[]>({
    queryKey: ["/api/boot-requests"],
    queryFn: () =>
      apiRequest("GET", "/api/boot-requests").then((r) => r.json()),
    refetchInterval: 30000,
    staleTime: 0,
  });
  const pendingRequests = useMemo<BootRequest[]>(
    () =>
      [...(bootRequestsQuery.data ?? [])]
        .filter((r) => r.status === "pending")
        .sort(
          (a, b) =>
            new Date(b.requestedAt).getTime() -
            new Date(a.requestedAt).getTime(),
        ),
    [bootRequestsQuery.data],
  );

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
  // Resolved *today* only — History and the day KPIs count today's work, so a
  // car resolved on a prior day drops off (its unresolved peers stay in Active).
  const resolvedToday = useMemo(
    () => resolvedCases.filter((c) => localDayKey(c.bootedAt, tzMin) === date),
    [resolvedCases, tzMin, date],
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

  // ---- Place-a-boot mutation (the "+" FAB flow) ----
  const createBoot = useMutation({
    mutationFn: (vars: {
      licensePlate: string;
      makeModel: string;
      color?: string | null;
      bootFee: number;
      bootedAt: string;
      photos?: string[];
    }) =>
      apiRequest("POST", "/api/boots", vars).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/preview/enforcer/cases"],
      });
      toast({
        title: "Boot placed",
        description: "The vehicle is now in your active enforcement queue.",
      });
      setView("queue");
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't place boot",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  // ---- Resolve a pending boot request: initiate (creates a real boot, carrying
  // make/model + color) or dismiss. Mirrors the admin Requests flow; the route
  // allows enforcer + admin roles. ----
  const resolveRequest = useMutation({
    mutationFn: (vars: {
      id: number;
      action: "initiate" | "dismiss";
      bootFee?: number;
    }) =>
      apiRequest("PATCH", `/api/boot-requests/${vars.id}`, {
        action: vars.action,
        bootFee: vars.bootFee,
      }).then((r) => r.json()),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/boot-requests"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/preview/enforcer/cases"],
      });
      toast({
        title:
          vars.action === "initiate" ? "Boot initiated" : "Request dismissed",
        description:
          vars.action === "initiate"
            ? "The vehicle is now an active boot in your queue."
            : "The request was closed without booting.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't resolve request",
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
        hasUnread={conflicts.length > 0 || pendingRequests.length > 0}
        active={view}
        onNavigate={(v) => {
          setView(v);
          if (v !== "case") setSelectedId(null);
        }}
        onOpenScan={() => setView("addboot")}
        onOpenMenu={() => setMenuOpen(true)}
        onOpenNotifications={() => setView("queue")}
        onSwitchView={isAdmin ? () => setMenuOpen(true) : undefined}
      >
        {!stripeOk && <StaleStripeBanner />}

        {view === "home" && (
          <HomePage
            activeCases={activeCases}
            resolvedCases={resolvedCases}
            resolvedToday={resolvedToday}
            conflicts={conflicts}
            pendingRequests={pendingRequests}
            paidCars30d={paidCars30d}
            loading={casesQuery.isLoading}
            paidLoading={paidCarsRangeQuery.isLoading}
            onOpenCase={openCase}
            onGoLookup={() => setView("lookup")}
            onGoQueue={() => setView("queue")}
          />
        )}

        {view === "lookup" && (
          <LookupPage
            query={query}
            setQuery={setQuery}
            resolvedCases={resolvedCases}
            paidCars30d={paidCars30d}
            loading={casesQuery.isLoading || paidCarsRangeQuery.isLoading}
            onOpenCase={openCase}
          />
        )}

        {view === "queue" && (
          <QueuePage
            activeCases={activeCases}
            pendingRequests={pendingRequests}
            requestsLoading={bootRequestsQuery.isLoading}
            loading={casesQuery.isLoading}
            onOpenCase={openCase}
            onInitiate={(r) =>
              resolveRequest.mutate({
                id: r.id,
                action: "initiate",
                bootFee: (r.suggestedFee ?? 0) > 0 ? r.suggestedFee : undefined,
              })
            }
            onDismiss={(r) =>
              resolveRequest.mutate({ id: r.id, action: "dismiss" })
            }
            resolving={resolveRequest.isPending}
          />
        )}

        {view === "history" && (
          <HistoryPage
            cases={resolvedToday}
            paidCarsToday={paidCarsToday}
            loading={casesQuery.isLoading}
            paidLoading={paidCarsQuery.isLoading}
          />
        )}

        {view === "addboot" && (
          <AddBootPage
            onBack={() => setView("home")}
            onSubmit={(vars) => createBoot.mutate(vars)}
            submitting={createBoot.isPending}
          />
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
          isAdmin={isAdmin}
          onClose={() => setMenuOpen(false)}
          onGoProfile={() => {
            setMenuOpen(false);
            setView("profile");
          }}
          onSwitchManagement={() => {
            setMenuOpen(false);
            window.location.hash = "#/preview/admin-mobile";
          }}
          onSwitchDesktop={() => {
            setMenuOpen(false);
            window.location.hash = "#/";
          }}
          onLogout={() => {
            setMenuOpen(false);
            void logout();
          }}
        />
      )}

      {view === "profile" && (
        <ProfileSheet
          userName={userName}
          lotName={lotName}
          onBack={() => setView("home")}
          onLogout={() => {
            void logout();
          }}
        />
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

// CaseScrollList — CaseCard rows inside a fixed-height scroll container. Used by
// the Home filter tabs (Booted / Released) so long lists never push the page.
function CaseScrollList({
  cases,
  onOpenCase,
  testid,
}: {
  cases: EnfCase[];
  onOpenCase: (id: number) => void;
  testid: string;
}) {
  return (
    <div className="px-4">
      <div
        className="overflow-y-auto rounded-[0.875rem]"
        style={{
          maxHeight: "22rem",
          background: "#fff",
          border: `1px solid ${ENF.line}`,
          WebkitOverflowScrolling: "touch",
        }}
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

// PendingRequestQuickList — a lightweight, read-only quick-glance list of boot
// requests awaiting an enforcer. Used by the Home "Awaiting" tab. Each row taps
// through to the full enforcement queue where the request can be initiated.
function PendingRequestQuickList({
  requests,
  onGoQueue,
  testid,
}: {
  requests: BootRequest[];
  onGoQueue: () => void;
  testid: string;
}) {
  return (
    <div className="px-4">
      <div
        className="overflow-y-auto rounded-[0.875rem] p-2.5"
        style={{
          maxHeight: "22rem",
          background: ENF.fieldBg ?? "#f4f7fa",
          border: `1px solid ${ENF.line}`,
          WebkitOverflowScrolling: "touch",
        }}
        data-testid={testid}
      >
        <div className="space-y-2.5" data-testid={`${testid}-list`}>
          {requests.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={onGoQueue}
              className="flex w-full items-center gap-3 rounded-2xl bg-white p-3 text-left"
              style={{ border: `1px solid ${ENF.line}` }}
              data-testid={`row-awaiting-${r.id}`}
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                style={{ background: ENF.amberSoft, color: ENF.amber }}
              >
                <Clock3 className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <PlateText plate={r.licensePlate} size={16} />
                <span
                  className="mt-0.5 block truncate text-[12px]"
                  style={{ color: ENF.ink2 }}
                >
                  {[r.makeModel, r.color].filter(Boolean).join(" \u00b7 ") ||
                    "\u2014"}
                </span>
                <span
                  className="mt-0.5 block truncate text-[11px]"
                  style={{ color: ENF.ink3 }}
                >
                  {format(parseISO(r.requestedAt), "MMM d, h:mm a")}
                  {r.requestedByName ? ` \u00b7 by ${r.requestedByName}` : ""}
                </span>
              </span>
              <ChevronRight
                className="h-5 w-5 shrink-0"
                style={{ color: ENF.ink3 }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 1 — Home
// ---------------------------------------------------------------------------
function HomePage({
  activeCases,
  resolvedCases,
  resolvedToday,
  conflicts,
  pendingRequests,
  paidCars30d,
  loading,
  paidLoading,
  onOpenCase,
  onGoLookup,
  onGoQueue,
}: {
  activeCases: EnfCase[];
  resolvedCases: EnfCase[];
  resolvedToday: EnfCase[];
  conflicts: EnfCase[];
  pendingRequests: BootRequest[];
  paidCars30d: PaidCarLite[];
  loading: boolean;
  paidLoading: boolean;
  onOpenCase: (id: number) => void;
  onGoLookup: () => void;
  onGoQueue: () => void;
}) {
  const collected = resolvedToday.reduce((s, c) => s + (c.amountCollected || 0), 0);
  // Session-only privacy toggle for the collected-today amount (no storage).
  const [showCollected, setShowCollected] = useState(true);

  // Filter-chip row — mirrors the attendant inventory filter chips. Each chip
  // selects a different data source for the "Active enforcement" panel:
  //   all      → active boots (everything currently enforced)
  //   booted   → active boots in a booted/reopened state
  //   awaiting → pending boot requests waiting on the enforcer
  //   released → released vehicles (from resolved history)
  //   paid     → paid vehicles (Stripe + manual, trailing 30 days)
  type HomeFilter = "all" | "booted" | "awaiting" | "released" | "paid";
  const [filter, setFilter] = useState<HomeFilter>("all");
  const activeBooted = activeCases.filter((c) =>
    ["booted", "reopened", "pending_enforcement"].includes(c.stage),
  );
  const releasedCases = resolvedCases.filter((c) => c.stage === "released");
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
        <div
          className="relative rounded-[0.875rem] px-3.5 py-[13px]"
          style={{ background: "#fff", border: `1px solid ${ENF.line}` }}
          data-testid="kpi-collected"
        >
          <button
            type="button"
            onClick={() => setShowCollected((v) => !v)}
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full"
            style={{ color: ENF.ink3 }}
            aria-label={showCollected ? "Hide collected amount" : "Show collected amount"}
            aria-pressed={!showCollected}
            data-testid="button-toggle-collected"
          >
            {showCollected ? (
              <Eye className="h-[17px] w-[17px]" />
            ) : (
              <EyeOff className="h-[17px] w-[17px]" />
            )}
          </button>
          <div
            className="text-[25px] font-extrabold leading-none tracking-[-0.02em]"
            style={{
              fontFamily: ENF_MONO,
              color: showCollected ? ENF.green : ENF.ink3,
            }}
            data-testid="kpi-collected-value"
          >
            {showCollected ? currency(collected) : "•••••"}
          </div>
          <div className="mt-1.5 text-[11.5px] font-semibold" style={{ color: ENF.ink2 }}>
            Collected today
          </div>
        </div>
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

      {/* Pending boot requests banner — links admin/attendant requests to the
          enforcer. Tapping jumps to the queue where they can be initiated. */}
      {pendingRequests.length > 0 && (
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={onGoQueue}
            className="flex w-full items-center gap-3 rounded-[0.875rem] px-3.5 py-3 text-left"
            style={{
              background: ENF.amberSoft,
              border: `1px solid ${ENF.amber}33`,
            }}
            data-testid="banner-pending-requests"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              style={{ background: "#fff", color: ENF.amber }}
            >
              <Clock3 className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block text-[13px] font-bold"
                style={{ color: ENF.ink }}
              >
                {pendingRequests.length} boot request
                {pendingRequests.length === 1 ? "" : "s"} waiting
              </span>
              <span
                className="block text-[11.5px] font-medium"
                style={{ color: ENF.ink2 }}
              >
                Tap to review and initiate
              </span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0" style={{ color: ENF.amber }} />
          </button>
        </div>
      )}

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

      {filter === "awaiting" ? (
        loading ? (
          <CardSkeleton />
        ) : pendingRequests.length === 0 ? (
          <EmptyState
            icon={<Clock3 className="h-7 w-7" />}
            title="No requests awaiting"
            sub="Boot requests from attendants and admins will appear here, ready to initiate."
          />
        ) : (
          <PendingRequestQuickList
            requests={pendingRequests}
            onGoQueue={onGoQueue}
            testid="list-awaiting-requests"
          />
        )
      ) : filter === "released" ? (
        loading ? (
          <CardSkeleton />
        ) : releasedCases.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-7 w-7" />}
            title="No released vehicles"
            sub="Vehicles you release after payment or resolution will be listed here."
          />
        ) : (
          <CaseScrollList
            cases={releasedCases}
            onOpenCase={onOpenCase}
            testid="list-released-vehicles"
          />
        )
      ) : filter === "paid" ? (
        paidLoading ? (
          <CardSkeleton />
        ) : paidCars30d.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-7 w-7" />}
            title="No paid vehicles"
            sub="Paid vehicles (Stripe and manual) from the last 30 days will be listed here."
          />
        ) : (
          <div className="px-4">
            <PaidCarScrollList cars={paidCars30d} testid="list-paid-vehicles" />
          </div>
        )
      ) : (
        // "all" and "booted" — active enforcement cases
        (() => {
          const cases = filter === "booted" ? activeBooted : activeCases;
          if (loading) return <CardSkeleton />;
          if (cases.length === 0)
            return (
              <EmptyState
                icon={<ShieldCheck className="h-7 w-7" />}
                title={filter === "booted" ? "No booted vehicles" : "No active boots"}
                sub="When you place a boot or one needs attention, it'll show up here."
              />
            );
          return (
            <CaseScrollList
              cases={cases}
              onOpenCase={onOpenCase}
              testid="list-active-enforcement"
            />
          );
        })()
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
  resolvedCases,
  paidCars30d,
  loading,
  onOpenCase,
}: {
  query: string;
  setQuery: (v: string) => void;
  resolvedCases: EnfCase[];
  paidCars30d: PaidCarLite[];
  loading: boolean;
  onOpenCase: (id: number) => void;
}) {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const q = norm(query);

  // Plate-only search across 30 days of resolved cases + paid cars (Stripe +
  // manual). No day filter — the search bar is the only control. We match on the
  // normalized plate so spacing/dashes don't matter.
  const caseMatches = q
    ? resolvedCases.filter((c) => norm(c.licensePlate).includes(q))
    : [];
  const paidMatches = q
    ? paidCars30d.filter((c) => norm(c.licensePlate).includes(q))
    : [];
  // An exact resolved-case match still gets the verification banner up top.
  const exact = q
    ? resolvedCases.find((c) => norm(c.licensePlate) === q)
    : undefined;
  const hasResults = caseMatches.length > 0 || paidMatches.length > 0;

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
        {!query && (
          <div
            className="mt-2 px-1 text-[11.5px] font-medium"
            style={{ color: ENF.ink3 }}
            data-testid="lookup-scope-hint"
          >
            Searches the last 30 days of resolved cases &amp; paid cars (Stripe +
            manual).
          </div>
        )}
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
          sub="Type a plate to check 30 days of resolved cases and paid history before you act."
        />
      )}

      {query && loading && <CardSkeleton />}

      {query && !loading && !hasResults && (
        <div className="px-4">
          <div
            className="rounded-[0.875rem] bg-white px-4 py-5 text-center"
            style={{ border: `1px solid ${ENF.line}` }}
            data-testid="lookup-no-match"
          >
            <div className="text-[15px] font-bold" style={{ color: ENF.ink }}>
              No match in the last 30 days
            </div>
            <div className="mt-1 text-[13px]" style={{ color: ENF.ink2 }}>
              No resolved case or paid record found for{" "}
              <span style={{ fontFamily: ENF_MONO }}>{query.toUpperCase()}</span>.
            </div>
          </div>
        </div>
      )}

      {query && !loading && caseMatches.length > 0 && (
        <>
          <SectionTitle>
            Resolved cases ({caseMatches.length})
          </SectionTitle>
          {/* Scroll container: keeps a long match list from pushing the page. */}
          <div className="px-4">
            <div
              className="overflow-y-auto rounded-[0.875rem]"
              style={{
                maxHeight: "20rem",
                background: "#fff",
                border: `1px solid ${ENF.line}`,
                WebkitOverflowScrolling: "touch",
              }}
              data-testid="scroll-lookup-cases"
            >
              <div data-testid="list-lookup-matches">
                {caseMatches.map((c, i) => (
                  <CaseCard
                    key={c.id}
                    c={c}
                    onOpen={onOpenCase}
                    last={i === caseMatches.length - 1}
                  />
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {query && !loading && paidMatches.length > 0 && (
        <>
          <SectionTitle>Paid records ({paidMatches.length})</SectionTitle>
          <div className="px-4">
            <PaidCarScrollList cars={paidMatches} testid="scroll-lookup-paid" />
          </div>
        </>
      )}
    </div>
  );
}

// PaidCarScrollList — a fixed-height scrolling list of paid-car cards (Stripe +
// manual), reused by Lookup and the Home "Paid" tab. Mirrors the History page
// paid-car card treatment so payment records read identically everywhere.
function PaidCarScrollList({
  cars,
  testid,
}: {
  cars: PaidCarLite[];
  testid: string;
}) {
  return (
    <div
      className="overflow-y-auto rounded-2xl p-2.5"
      style={{
        maxHeight: "22rem",
        background: ENF.fieldBg ?? "#f4f7fa",
        border: `1px solid ${ENF.line}`,
        WebkitOverflowScrolling: "touch",
      }}
      data-testid={testid}
    >
      <div className="space-y-2.5" data-testid={`${testid}-list`}>
        {cars.map((c) => (
          <div
            key={c.id}
            className="rounded-2xl border bg-white p-3.5"
            style={{ borderColor: ENF.line }}
            data-testid={`card-paid-${c.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <PlateText plate={c.licensePlate} size={17} />
                <div
                  className="mt-0.5 truncate text-[12.5px]"
                  style={{ color: ENF.ink2 }}
                >
                  {[c.makeModel, c.color].filter(Boolean).join(" \u00b7 ") ||
                    "\u2014"}
                </div>
              </div>
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                style={
                  c.source === "manual"
                    ? { background: ENF.greenSoft, color: ENF.green }
                    : { background: ENF.accentSoft, color: ENF.accent }
                }
                data-testid={`paid-source-${c.id}`}
              >
                {c.source === "manual" ? "Manual" : "Stripe"}
              </span>
            </div>
            <div
              className="mt-2.5 flex items-center justify-between border-t pt-2.5 text-[11.5px]"
              style={{ borderColor: ENF.line, color: ENF.ink3 }}
            >
              <span className="truncate">{dateTimeLabel(c.paidAt)}</span>
            </div>
          </div>
        ))}
      </div>
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
// PendingRequestCard — a boot request submitted by an admin or attendant that is
// waiting for the enforcer to initiate (place a real boot) or dismiss it.
function PendingRequestCard({
  request,
  onInitiate,
  onDismiss,
  resolving,
}: {
  request: BootRequest;
  onInitiate: (r: BootRequest) => void;
  onDismiss: (r: BootRequest) => void;
  resolving: boolean;
}) {
  return (
    <div
      className="rounded-[0.875rem] bg-white p-3.5"
      style={{ border: `1px solid ${ENF.line}` }}
      data-testid={`card-request-${request.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <PlateText
            plate={request.licensePlate}
            size={19}
            testid={`text-request-plate-${request.id}`}
          />
          <div
            className="mt-1 text-[13px] font-semibold"
            style={{ color: ENF.ink }}
            data-testid={`text-request-makemodel-${request.id}`}
          >
            {request.makeModel}
            {request.color ? (
              <span style={{ color: ENF.ink2 }}> · {request.color}</span>
            ) : null}
          </div>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.04em]"
          style={{ background: ENF.amberSoft, color: ENF.amber }}
        >
          Requested
        </span>
      </div>

      <div
        className="mt-2 flex items-center gap-1 text-[11.5px]"
        style={{ color: ENF.ink2 }}
      >
        <Clock3 className="h-3.5 w-3.5" />
        {format(parseISO(request.requestedAt), "MMM d, h:mm a")}
        {request.requestedByName ? (
          <span data-testid={`text-request-by-${request.id}`}>
            {" "}· by {request.requestedByName}
          </span>
        ) : null}
      </div>

      {(request.suggestedFee ?? 0) > 0 && (
        <div className="mt-1 text-[11.5px]" style={{ color: ENF.ink2 }}>
          Suggested fee:{" "}
          <span className="font-semibold" style={{ fontFamily: ENF_MONO }}>
            {currency(request.suggestedFee)}
          </span>
        </div>
      )}
      {request.note ? (
        <div
          className="mt-1.5 text-[12px]"
          style={{ color: ENF.ink2 }}
          data-testid={`text-request-note-${request.id}`}
        >
          “{request.note}”
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={resolving}
          onClick={() => onInitiate(request)}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[0.75rem] text-[13px] font-bold text-white disabled:opacity-60"
          style={{ background: ENF.orange }}
          data-testid={`button-initiate-${request.id}`}
        >
          <Wrench className="h-4 w-4" />
          Initiate boot
        </button>
        <button
          type="button"
          disabled={resolving}
          onClick={() => onDismiss(request)}
          className="flex h-11 items-center justify-center gap-1.5 rounded-[0.75rem] px-4 text-[13px] font-bold disabled:opacity-60"
          style={{
            background: "#fff",
            color: ENF.ink2,
            border: `1px solid ${ENF.line}`,
          }}
          data-testid={`button-dismiss-${request.id}`}
        >
          <X className="h-4 w-4" />
          Dismiss
        </button>
      </div>
    </div>
  );
}

function QueuePage({
  activeCases,
  pendingRequests,
  requestsLoading,
  loading,
  onOpenCase,
  onInitiate,
  onDismiss,
  resolving,
}: {
  activeCases: EnfCase[];
  pendingRequests: BootRequest[];
  requestsLoading: boolean;
  loading: boolean;
  onOpenCase: (id: number) => void;
  onInitiate: (r: BootRequest) => void;
  onDismiss: (r: BootRequest) => void;
  resolving: boolean;
}) {
  // Plain-text search across plate + make/model for both pending requests and
  // active enforcement cases.
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matchReq = (r: BootRequest) =>
    !needle ||
    r.licensePlate.toLowerCase().includes(needle) ||
    r.makeModel.toLowerCase().includes(needle) ||
    (r.color ?? "").toLowerCase().includes(needle);
  const matchCase = (c: EnfCase) =>
    !needle ||
    c.licensePlate.toLowerCase().includes(needle) ||
    (c.makeModel ?? "").toLowerCase().includes(needle) ||
    (c.color ?? "").toLowerCase().includes(needle);
  const filteredRequests = pendingRequests.filter(matchReq);
  const filteredCases = activeCases.filter(matchCase);

  return (
    <div className="pb-6" data-testid="page-enforcer-queue">
      {/* Search bar — filters both pending requests and active cases. */}
      <div className="px-4 pt-4">
        <QueueSearch value={q} onChange={setQ} testid="input-queue-search" />
      </div>

      {/* Pending requests from admin/attendant awaiting an enforcer decision. */}
      <SectionTitle>Pending requests · {filteredRequests.length}</SectionTitle>
      {requestsLoading ? (
        <CardSkeleton />
      ) : filteredRequests.length === 0 ? (
        <EmptyState
          icon={<Clock3 className="h-7 w-7" />}
          title={needle ? "No matching requests" : "No pending requests"}
          sub={
            needle
              ? "Try a different plate or make/model."
              : "Boot requests from staff and admin will appear here for you to initiate."
          }
        />
      ) : (
        <div className="space-y-2.5 px-4">
          {filteredRequests.map((r) => (
            <PendingRequestCard
              key={r.id}
              request={r}
              onInitiate={onInitiate}
              onDismiss={onDismiss}
              resolving={resolving}
            />
          ))}
        </div>
      )}

      <SectionTitle>Enforcement queue · {filteredCases.length}</SectionTitle>
      {loading ? (
        <CardSkeleton />
      ) : filteredCases.length === 0 ? (
        <EmptyState
          icon={<ListChecksIcon />}
          title={needle ? "No matching cases" : "Queue is clear"}
          sub={
            needle
              ? "Try a different plate or make/model."
              : "No active boots or pending actions right now."
          }
        />
      ) : (
        <CaseList cases={filteredCases} onOpenCase={onOpenCase} testid="list-queue" />
      )}
    </div>
  );
}

// QueueSearch — ENF-styled plain-text search input reused on the queue page.
function QueueSearch({
  value,
  onChange,
  testid,
  placeholder = "Search plate or make/model",
}: {
  value: string;
  onChange: (v: string) => void;
  testid?: string;
  placeholder?: string;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-[0.75rem] bg-white px-3"
      style={{ border: `1px solid ${ENF.line}`, height: 44 }}
    >
      <SearchIcon className="h-[18px] w-[18px]" style={{ color: ENF.ink3 }} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
        style={{ color: ENF.ink }}
        data-testid={testid}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="flex h-6 w-6 items-center justify-center rounded-full"
          style={{ color: ENF.ink3 }}
          aria-label="Clear search"
          data-testid={testid ? `${testid}-clear` : undefined}
        >
          <X className="h-4 w-4" />
        </button>
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
// Place a Boot — opened from the "+" FAB. Captures the minimum fields needed to
// register a new boot enforcement action (plate, vehicle, fee), then POSTs to
// /api/boots. Photos/GPS are added later from the case detail, matching the
// rest of the field flow.
// ---------------------------------------------------------------------------
function AddBootPage({
  onBack,
  onSubmit,
  submitting,
}: {
  onBack: () => void;
  onSubmit: (vars: {
    licensePlate: string;
    makeModel: string;
    color?: string | null;
    bootFee: number;
    bootedAt: string;
    photos?: string[];
  }) => void;
  submitting: boolean;
}) {
  const MAX_PHOTOS = 5;
  const [plate, setPlate] = useState("");
  const [makeModel, setMakeModel] = useState("");
  const [color, setColor] = useState("");
  const [fee, setFee] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const feeNum = parseFloat(fee || "0") || 0;
  const canSubmit =
    plate.trim().length > 0 && makeModel.trim().length > 0 && !submitting;

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = Math.max(0, MAX_PHOTOS - photos.length);
    const chosen = Array.from(files).slice(0, remaining);
    chosen.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setPhotos((prev) =>
            prev.length >= MAX_PHOTOS ? prev : [...prev, reader.result as string],
          );
        }
      };
      reader.readAsDataURL(file);
    });
  }

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      licensePlate: plate.trim().toUpperCase(),
      makeModel: makeModel.trim(),
      color: color.trim() || null,
      bootFee: feeNum,
      bootedAt: new Date().toISOString(),
      photos,
    });
  }

  const fieldWrap =
    "mt-1.5 flex items-center gap-2 rounded-xl px-3.5 py-3";
  const fieldStyle = { border: `1px solid ${ENF.line}` } as const;
  const inputCls =
    "flex-1 bg-transparent text-[16px] font-semibold outline-none";

  return (
    <div className="pb-8" data-testid="page-enforcer-addboot">
      <div className="px-4 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-bold"
          style={{ color: ENF.accent }}
          data-testid="button-addboot-back"
        >
          <ArrowLeft className="h-4 w-4" />
          Cancel
        </button>
      </div>

      <div className="px-4 pt-2">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-full"
            style={{ background: ENF.orange }}
          >
            <Plus className="h-[22px] w-[22px] text-white" strokeWidth={2.6} />
          </div>
          <div>
            <div className="text-[17px] font-extrabold" style={{ color: ENF.ink }}>
              Place a boot
            </div>
            <div className="text-[12.5px] font-medium" style={{ color: ENF.ink2 }}>
              Register a new enforcement action.
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 pt-4">
        <div
          className="rounded-[0.875rem] bg-white p-4"
          style={{ border: `1px solid ${ENF.line}` }}
        >
          {/* License plate */}
          <label className="text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: ENF.ink3 }}>
            License plate
          </label>
          <div className={fieldWrap} style={fieldStyle}>
            <Tag className="h-[18px] w-[18px]" style={{ color: ENF.ink3 }} />
            <input
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              placeholder="ABC 1234"
              autoCapitalize="characters"
              className={inputCls}
              style={{ color: ENF.ink, letterSpacing: "0.06em" }}
              data-testid="input-addboot-plate"
            />
          </div>

          {/* Make & model */}
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: ENF.ink3 }}>
            Make & model
          </label>
          <div className={fieldWrap} style={fieldStyle}>
            <Car className="h-[18px] w-[18px]" style={{ color: ENF.ink3 }} />
            <input
              value={makeModel}
              onChange={(e) => setMakeModel(e.target.value)}
              placeholder="e.g. Honda Civic"
              className={inputCls}
              style={{ color: ENF.ink }}
              data-testid="input-addboot-makemodel"
            />
          </div>

          {/* Color (optional) */}
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: ENF.ink3 }}>
            Color <span className="normal-case" style={{ color: ENF.ink3 }}>(optional)</span>
          </label>
          <div className={fieldWrap} style={fieldStyle}>
            <input
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="e.g. Silver"
              className={inputCls}
              style={{ color: ENF.ink }}
              data-testid="input-addboot-color"
            />
          </div>

          {/* Boot fee */}
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: ENF.ink3 }}>
            Boot fee
          </label>
          <div className={fieldWrap} style={fieldStyle}>
            <span className="text-[16px] font-bold" style={{ color: ENF.ink3 }}>$</span>
            <input
              value={fee}
              onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0.00"
              className={inputCls}
              style={{ color: ENF.ink }}
              data-testid="input-addboot-fee"
            />
          </div>

          {/* Evidence photos — captured on the intake form (optional). */}
          <label
            className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.04em]"
            style={{ color: ENF.ink3 }}
          >
            Evidence photos{" "}
            <span className="normal-case" style={{ color: ENF.ink3 }}>
              (optional, up to {MAX_PHOTOS})
            </span>
          </label>
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
            data-testid="input-addboot-photo"
          />
          <div className="mt-1.5 flex flex-wrap gap-2.5">
            {photos.map((src, i) => (
              <div
                key={i}
                className="relative h-[88px] w-[120px] overflow-hidden rounded-[12px]"
                style={{ border: `1px solid ${ENF.line}` }}
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
                  data-testid={`button-addboot-remove-photo-${i}`}
                >
                  <X className="h-[13px] w-[13px] text-white" />
                </button>
              </div>
            ))}
            {photos.length < MAX_PHOTOS && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-[88px] w-[120px] flex-col items-center justify-center gap-1.5 rounded-[12px]"
                style={{
                  background: ENF.accentSoft,
                  border: `1.5px dashed ${ENF.accent}`,
                  color: ENF.accentInk,
                }}
                data-testid="button-addboot-add-photo"
              >
                <Camera className="h-[20px] w-[20px]" />
                <span className="text-[12px] font-semibold">Add photo</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 pt-4">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="flex w-full items-center justify-center gap-2 rounded-[0.875rem] py-3.5 text-[15px] font-bold text-white disabled:opacity-50"
          style={{ background: ENF.orange }}
          data-testid="button-addboot-submit"
        >
          <Plus className="h-[18px] w-[18px]" strokeWidth={2.6} />
          {submitting ? "Placing boot…" : "Place boot"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 7 — History (resolved cases)
// ---------------------------------------------------------------------------
function HistoryPage({
  cases,
  paidCarsToday,
  loading,
  paidLoading,
}: {
  cases: EnfCase[];
  paidCarsToday: PaidCarLite[];
  loading: boolean;
  paidLoading: boolean;
}) {
  const collected = cases.reduce((s, c) => s + (c.amountCollected || 0), 0);
  // Plain-text search across plate + make/model + color for both lists.
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matchPaid = (c: PaidCarLite) =>
    !needle ||
    c.licensePlate.toLowerCase().includes(needle) ||
    (c.makeModel ?? "").toLowerCase().includes(needle) ||
    (c.color ?? "").toLowerCase().includes(needle);
  const matchCase = (c: EnfCase) =>
    !needle ||
    c.licensePlate.toLowerCase().includes(needle) ||
    (c.makeModel ?? "").toLowerCase().includes(needle) ||
    (c.color ?? "").toLowerCase().includes(needle);
  const filteredPaid = paidCarsToday.filter(matchPaid);
  const filteredCases = cases.filter(matchCase);
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

      {/* Search bar — filters both paid cars and resolved cases. */}
      <div className="px-4 pt-4">
        <QueueSearch value={q} onChange={setQ} testid="input-history-search" />
      </div>

      {/* ----- Active paid cars today (Stripe + manual) ----- */}
      <div className="flex items-center justify-between px-4 pt-5">
        <div className="text-[13px] font-bold uppercase tracking-[0.04em]" style={{ color: ENF.ink2 }}>
          Active paid cars today
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-bold"
          style={{ background: ENF.greenSoft, color: ENF.green }}
          data-testid="paid-today-count"
        >
          {filteredPaid.length} paid
        </span>
      </div>
      <div className="px-4 pt-2.5">
        {paidLoading ? (
          <CardSkeleton />
        ) : filteredPaid.length === 0 ? (
          <EmptyState
            icon={<CircleDollarSign className="h-7 w-7" />}
            title={needle ? "No matching paid cars" : "No paid cars yet today"}
            sub={
              needle
                ? "Try a different plate or make/model."
                : "Cars paid today (Stripe or manual) will appear here."
            }
          />
        ) : (
          // Fixed-height scroll table: keeps the History page from growing to the
          // bottom no matter how many cars were paid. The list scrolls inside
          // this box; the page stays a stable, predictable height.
          <div
            className="overflow-y-auto rounded-2xl p-2.5"
            style={{
              maxHeight: "22rem",
              background: ENF.fieldBg ?? "#f4f7fa",
              border: `1px solid ${ENF.line}`,
              WebkitOverflowScrolling: "touch",
            }}
            data-testid="scroll-paid-today"
          >
            <div className="space-y-2.5" data-testid="list-paid-today">
            {filteredPaid.map((c) => (
              <div
                key={c.id}
                className="rounded-2xl border bg-white p-3.5"
                style={{ borderColor: ENF.line }}
                data-testid={`card-paid-${c.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <PlateText plate={c.licensePlate} size={17} />
                    <div className="mt-0.5 truncate text-[12.5px]" style={{ color: ENF.ink2 }}>
                      {[c.makeModel, c.color].filter(Boolean).join(" \u00b7 ") || "\u2014"}
                    </div>
                  </div>
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                    style={
                      c.source === "stripe"
                        ? { background: ENF.accentSoft, color: ENF.accent }
                        : { background: ENF.greenSoft, color: ENF.green }
                    }
                    data-testid={`paid-source-${c.id}`}
                  >
                    {c.source === "stripe" ? "Stripe" : "Manual"}
                  </span>
                </div>
                <div
                  className="mt-2.5 flex items-center justify-between border-t pt-2.5 text-[11.5px]"
                  style={{ borderColor: ENF.line, color: ENF.ink3 }}
                >
                  <span className="truncate">{dateTimeLabel(c.paidAt)}</span>
                </div>
              </div>
            ))}
            </div>
          </div>
        )}
      </div>

      <SectionTitle>Resolved cases</SectionTitle>
      {loading ? (
        <CardSkeleton />
      ) : filteredCases.length === 0 ? (
        <EmptyState
          icon={<Clock3 className="h-7 w-7" />}
          title={needle ? "No matching cases" : "Nothing resolved yet"}
          sub={
            needle
              ? "Try a different plate or make/model."
              : "Paid and released cases from today will appear here."
          }
        />
      ) : (
        <CaseList cases={filteredCases} onOpenCase={() => {}} testid="list-history" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page 8/9 — Profile menu + sheet
// ---------------------------------------------------------------------------
function ProfileMenu({
  userName,
  isAdmin,
  onClose,
  onGoProfile,
  onSwitchManagement,
  onSwitchDesktop,
  onLogout,
}: {
  userName: string;
  isAdmin?: boolean;
  onClose: () => void;
  onGoProfile: () => void;
  onSwitchManagement: () => void;
  onSwitchDesktop: () => void;
  onLogout: () => void;
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
        {isAdmin && (
          <>
            <div
              className="mt-4 mb-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.06em]"
              style={{ color: ENF.ink3 }}
              data-testid="menu-switch-heading"
            >
              Switch view
            </div>
            <button
              type="button"
              onClick={onSwitchManagement}
              className="flex w-full items-center justify-between rounded-[0.875rem] px-4 py-3.5 text-[15px] font-bold"
              style={{ background: ENF.fieldBg, color: ENF.ink }}
              data-testid="button-menu-switch-management"
            >
              <span className="flex items-center gap-2.5">
                <LayoutDashboard className="h-[18px] w-[18px]" style={{ color: ENF.ink2 }} />
                Management view
              </span>
              <ChevronRight className="h-4 w-4" style={{ color: ENF.ink3 }} />
            </button>
            <button
              type="button"
              onClick={onSwitchDesktop}
              className="mt-2.5 flex w-full items-center justify-between rounded-[0.875rem] px-4 py-3.5 text-[15px] font-bold"
              style={{ background: ENF.fieldBg, color: ENF.ink }}
              data-testid="button-menu-switch-desktop"
            >
              <span className="flex items-center gap-2.5">
                <Monitor className="h-[18px] w-[18px]" style={{ color: ENF.ink2 }} />
                Desktop dashboard
              </span>
              <ChevronRight className="h-4 w-4" style={{ color: ENF.ink3 }} />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-[0.875rem] px-4 py-3.5 text-[15px] font-bold"
          style={{ background: ENF.redSoft, color: ENF.red }}
          data-testid="button-menu-logout"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </div>
  );
}

function ProfileSheet({
  userName,
  lotName,
  onBack,
  onLogout,
}: {
  userName: string;
  lotName: string;
  onBack: () => void;
  onLogout: () => void;
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

        {/* Sign out — lives inside the settings screen so the enforcer can end
            the session here, not only from the bottom-sheet menu. */}
        <button
          type="button"
          onClick={onLogout}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-[0.875rem] px-4 py-3.5 text-[15px] font-bold"
          style={{ background: ENF.redSoft, color: ENF.red }}
          data-testid="button-profile-logout"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
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
