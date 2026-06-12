import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck,
  Bell,
  RefreshCcw,
  Eye,
  EyeOff,
  TrendingUp,
  Gavel,
  AlertTriangle,
  Inbox,
  Unlock,
  Users as UsersIcon,
  MapPin,
  ParkingMeter,
  DollarSign,
  CreditCard,
  CheckCircle2,
  ChevronRight,
  Landmark,
  Banknote,
  Wallet,
  CalendarCheck,
  Car,
  Coins,
  LayoutDashboard,
  BarChart3,
  History as HistoryIcon,
  Settings as SettingsIcon,
  Clock,
  Trash2,
  Search as SearchIcon,
  X as XIcon,
} from "lucide-react";
import logoMark from "@assets/logo-mark.png";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { EnforcementStage } from "@shared/schema";
import {
  ENF,
  ENF_FONT,
  PlateText,
  StageBadge,
} from "@/components/enforcer-preview/EnforcerShell";

// =============================================================================
// Admin Mobile Management Preview (preview-only, admin-only)
// =============================================================================
// A single scrollable mobile dashboard that gives an admin complete at-a-glance
// visibility: today's daily totals, live active-count trackers, this-month
// rollup, a 7-day trend, the full recent-activity feed, and staff/location
// rollups. Reuses the enforcer-preview design tokens for visual consistency,
// but is a self-contained read-only management surface (no bottom nav / FAB).

const TZ_OFFSET = new Date().getTimezoneOffset();

type OverviewResponse = {
  date: string;
  stripeOk: boolean;
  today: {
    booted: number;
    collected: number;
    resolved: number;
    parkedTotal: number;
    paidStripe: number;
    cashPaymentsTotal: number;
    cashPaymentsCount: number;
  };
  active: {
    boots: number;
    needsReview: number;
    pendingRequests: number;
    pendingReleases: number;
  };
  cash: {
    owedToBank: number;
    owedCount: number;
    reconciledTotal: number;
    collectedToday: number;
    allTotal: number;
    allCount: number;
    holders: { id: number; name: string; owed: number; count: number }[];
    recent: {
      id: number;
      licensePlate: string;
      amount: number;
      collectedByName: string;
      collectedAt: string;
      reconciled: boolean;
    }[];
  };
  month: { label: string; booted: number; collected: number };
  trend: { day: string; booted: number; collected: number; isToday: boolean }[];
  paidCars: {
    id: string;
    licensePlate: string;
    makeModel: string;
    color: string | null;
    paidAt: string;
    source: "manual" | "stripe";
    amount: number | null;
    method: "cash" | "card" | "app" | null;
    space: string | null;
  }[];
  recent: {
    id: number;
    licensePlate: string;
    makeModel: string;
    color: string | null;
    bootedAt: string;
    resolvedAt: string | null;
    bootFee: number;
    amountCollected: number | null;
    status: string;
    stage: EnforcementStage;
    locationId: number | null;
    paidConflict: boolean;
    lastActionByName: string | null;
  }[];
  staff: { total: number; active: number; enforcers: number; attendants: number };
  locations: {
    total: number;
    active: number;
    list: { id: number; name: string; active: boolean }[];
  };
};

function currency(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function weekday(day: string): string {
  const [y, mo, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
}

function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

type AdminTab = "dashboard" | "charts" | "history" | "settings";
type RecentMode = "activity" | "paid";

export function AdminMobilePreview() {
  const [showMoney, setShowMoney] = useState(true);
  const [tab, setTab] = useState<AdminTab>("dashboard");
  const [recentMode, setRecentMode] = useState<RecentMode>("activity");
  const [recentFilter, setRecentFilter] = useState<"all" | "active" | "resolved">(
    "all",
  );

  const query = useQuery<OverviewResponse>({
    queryKey: ["/api/preview/admin/overview", TZ_OFFSET],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/preview/admin/overview?tz=${TZ_OFFSET}`,
      );
      return res.json();
    },
    refetchInterval: 30000,
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Delete a MANUAL paid-car entry (admin only). Keyed on the snapshot
  // sessionId (the paidCars `id`). Stripe rows are never deletable — the button
  // is only rendered for source === "manual" and the server enforces it too.
  const deletePaidMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await apiRequest(
        "DELETE",
        `/api/paid-cars/manual/${encodeURIComponent(sessionId)}`,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/preview/admin/overview"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/paid-cars"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      toast({ title: "Removed", description: "Manual paid entry deleted." });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not delete entry",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const data = query.data;

  // Quick-search across plate / make-model / color for the recent + paid lists.
  const [recentSearch, setRecentSearch] = useState("");
  const recentNeedle = recentSearch.trim().toLowerCase();
  const filteredRecent = useMemo(() => {
    if (!data) return [];
    let rows = data.recent;
    if (recentFilter === "active")
      rows = rows.filter((r) => (r.status ?? "booted") === "booted");
    else if (recentFilter === "resolved")
      rows = rows.filter((r) => (r.status ?? "booted") !== "booted");
    if (recentNeedle)
      rows = rows.filter(
        (r) =>
          r.licensePlate.toLowerCase().includes(recentNeedle) ||
          (r.makeModel ?? "").toLowerCase().includes(recentNeedle) ||
          (r.color ?? "").toLowerCase().includes(recentNeedle),
      );
    return rows;
  }, [data, recentFilter, recentNeedle]);
  const filteredPaid = useMemo(() => {
    if (!data) return [];
    if (!recentNeedle) return data.paidCars;
    return data.paidCars.filter(
      (c) =>
        c.licensePlate.toLowerCase().includes(recentNeedle) ||
        (c.makeModel ?? "").toLowerCase().includes(recentNeedle) ||
        (c.color ?? "").toLowerCase().includes(recentNeedle),
    );
  }, [data, recentNeedle]);

  const maxBooted = useMemo(
    () => (data ? Math.max(1, ...data.trend.map((t) => t.booted)) : 1),
    [data],
  );

  const money = (n: number) => (showMoney ? currency(n) : "••••");

  return (
    <div
      className="min-h-screen pb-24"
      style={{ background: ENF.fieldBg, color: ENF.ink, fontFamily: ENF_FONT }}
      data-testid="admin-mobile-shell"
    >
      {/* Header — dark navy gradient, matches enforcer/attendant field mode */}
      <header
        className="sticky top-0 z-10 px-4 pb-5 pt-4 text-white"
        style={{ background: `linear-gradient(160deg, ${ENF.header}, ${ENF.header2})` }}
        data-testid="admin-header"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[9px] bg-white">
              <img src={logoMark} alt="Millennialz Parking, LLC" className="h-full w-full object-contain p-0.5" />
            </span>
            <div className="leading-[1.15]">
              <div className="text-sm font-bold" data-testid="admin-title">Management</div>
              <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-white/60">
                <ShieldCheck className="h-3 w-3" /> Admin · all lots
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-white/90">
            <button
              type="button"
              onClick={() => query.refetch()}
              aria-label="Refresh data"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 active:bg-white/20"
              data-testid="button-admin-refresh"
            >
              <RefreshCcw className={`h-[18px] w-[18px] ${query.isFetching ? "animate-spin" : ""}`} />
            </button>
            <button type="button" aria-label="Notifications" className="relative flex" data-testid="button-admin-notifications">
              <Bell className="h-[21px] w-[21px]" />
            </button>
          </div>
        </div>

        {/* Stale-Stripe banner */}
        {data && !data.stripeOk && (
          <div
            className="mt-3 rounded-lg px-3 py-2 text-[11.5px] font-medium"
            style={{ background: "rgba(176,111,0,.22)", color: "#ffd9a0" }}
            data-testid="admin-stale-banner"
          >
            Payment data may be stale — Stripe was briefly unreachable.
          </div>
        )}
      </header>

      <main className="space-y-5 px-4 pt-5">
        {query.isError && (
          <div
            className="rounded-xl border bg-white p-4 text-sm font-medium"
            style={{ borderColor: ENF.line, color: ENF.red }}
            data-testid="admin-error"
          >
            Couldn't load the dashboard. Tap refresh to try again.
          </div>
        )}

        {/* ======================= DASHBOARD TAB ======================= */}
        {tab === "dashboard" && (
        <>

        {/* ===== DAILY TOTALS (today) ===== */}
        <section data-testid="section-daily-totals">
          <SectionLabel
            title="Today"
            right={
              <button
                type="button"
                onClick={() => setShowMoney((s) => !s)}
                className="flex items-center gap-1 text-[11px] font-semibold"
                style={{ color: ENF.ink2 }}
                data-testid="button-toggle-money"
                aria-label={showMoney ? "Hide amounts" : "Show amounts"}
              >
                {showMoney ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                {showMoney ? "Hide $" : "Show $"}
              </button>
            }
          />
          <div className="grid grid-cols-2 gap-3">
            <TotalCard
              icon={<CalendarCheck className="h-[18px] w-[18px]" />}
              label="Reservations / confirmations"
              value="0"
              sublabel="Coming soon"
              tone="info"
              testid="kpi-today-reservations"
            />
            <TotalCard
              icon={<Car className="h-[18px] w-[18px]" />}
              label="Total parked cars today"
              value={data ? String(data.today.parkedTotal) : null}
              tone="neutral"
              testid="kpi-today-parked"
            />
            <TotalCard
              icon={<Coins className="h-[18px] w-[18px]" />}
              label="Cash payments tracker"
              value={data ? money(data.today.cashPaymentsTotal) : null}
              sublabel={
                data
                  ? `${data.today.cashPaymentsCount} ${
                      data.today.cashPaymentsCount === 1 ? "payment" : "payments"
                    }`
                  : undefined
              }
              tone="paid"
              testid="kpi-today-cash"
            />
            <TotalCard
              icon={<CreditCard className="h-[18px] w-[18px]" />}
              label="Total payments Stripe"
              value={data ? String(data.today.paidStripe) : null}
              tone="neutral"
              testid="kpi-today-stripe"
            />
          </div>
        </section>

        {/* ===== ACTIVE COUNT TRACKERS (live) ===== */}
        <section data-testid="section-active-trackers">
          <SectionLabel title="Active now" />
          <div className="grid grid-cols-2 gap-3">
            <TrackerCard
              icon={<Gavel className="h-[18px] w-[18px]" />}
              label="Active boots"
              value={data ? data.active.boots : null}
              tone={data && data.active.boots > 0 ? "active" : "neutral"}
              testid="tracker-active-boots"
            />
            <TrackerCard
              icon={<AlertTriangle className="h-[18px] w-[18px]" />}
              label="Needs review"
              value={data ? data.active.needsReview : null}
              tone={data && data.active.needsReview > 0 ? "review" : "neutral"}
              testid="tracker-needs-review"
            />
            <TrackerCard
              icon={<Inbox className="h-[18px] w-[18px]" />}
              label="Boot requests"
              value={data ? data.active.pendingRequests : null}
              tone={data && data.active.pendingRequests > 0 ? "review" : "neutral"}
              testid="tracker-boot-requests"
            />
            <TrackerCard
              icon={<Unlock className="h-[18px] w-[18px]" />}
              label="Release requests"
              value={data ? data.active.pendingReleases : null}
              tone={data && data.active.pendingReleases > 0 ? "review" : "neutral"}
              testid="tracker-release-requests"
            />
            {/* 5th tile spans full width — collected fee total */}
            <div
              className="col-span-2 flex items-center justify-between rounded-2xl border bg-white p-4"
              style={{ borderColor: ENF.line }}
              data-testid="tracker-collected-fee"
            >
              <div className="flex items-center gap-3">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-xl"
                  style={{ background: ENF.greenSoft, color: ENF.green }}
                >
                  <DollarSign className="h-[18px] w-[18px]" />
                </span>
                <div className="text-[12px] font-medium" style={{ color: ENF.ink2 }}>
                  Collected fee
                  <div className="text-[10.5px]" style={{ color: ENF.ink3 }}>
                    Today’s fees collected
                  </div>
                </div>
              </div>
              {data ? (
                <span className="text-2xl font-bold leading-none" style={{ color: ENF.green }}>
                  {money(data.today.collected)}
                </span>
              ) : (
                <div className="h-7 w-20 animate-pulse rounded" style={{ background: ENF.graySoft }} />
              )}
            </div>
          </div>
        </section>

        {/* ===== CASH OWED TO BANK (hero widget) ===== */}
        <section data-testid="section-cash-owed">
          <SectionLabel
            title="Cash owed to bank"
            right={
              data && data.cash.owedCount > 0 ? (
                <span
                  className="rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide"
                  style={{ background: ENF.amberSoft, color: ENF.amber }}
                  data-testid="cash-owed-flag"
                >
                  Not deposited
                </span>
              ) : undefined
            }
          />
          <div
            className="rounded-2xl border p-4"
            style={{
              borderColor: data && data.cash.owedToBank > 0 ? ENF.amber : ENF.line,
              background:
                data && data.cash.owedToBank > 0 ? ENF.amberSoft : "#fff",
            }}
            data-testid="card-cash-owed"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className="flex h-11 w-11 items-center justify-center rounded-2xl"
                  style={{
                    background:
                      data && data.cash.owedToBank > 0 ? "#fff" : ENF.amberSoft,
                    color: ENF.amber,
                  }}
                >
                  <Landmark className="h-[22px] w-[22px]" />
                </span>
                <div>
                  <div
                    className="text-[28px] font-bold leading-none"
                    style={{ color: ENF.amber }}
                    data-testid="cash-owed-amount"
                  >
                    {data ? money(data.cash.owedToBank) : "—"}
                  </div>
                  <div
                    className="mt-1.5 text-[12px] font-medium"
                    style={{ color: ENF.ink2 }}
                  >
                    {data
                      ? `${data.cash.owedCount} ${
                          data.cash.owedCount === 1 ? "entry" : "entries"
                        } held by staff`
                      : ""}
                  </div>
                </div>
              </div>
            </div>
            <p
              className="mt-3 border-t pt-3 text-[11.5px] leading-snug"
              style={{ borderColor: ENF.line, color: ENF.ink3 }}
            >
              Field cash collected but not yet deposited. Reconcile each entry
              once it's handed over and banked.
            </p>
          </div>
        </section>

        {/* ===== CASH TRACKER (ledger detail) ===== */}
        <section data-testid="section-cash-tracker">
          <SectionLabel
            title="Cash tracker"
            right={
              <span
                className="flex items-center gap-1 text-[11px] font-semibold"
                style={{ color: ENF.ink2 }}
              >
                <Wallet className="h-4 w-4" /> Reconciliation
              </span>
            }
          />
          <div
            className="rounded-2xl border bg-white p-4"
            style={{ borderColor: ENF.line }}
            data-testid="card-cash-tracker"
          >
            {/* Summary row: collected today / owed / reconciled */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div data-testid="cash-stat-today">
                <div className="text-lg font-bold leading-none" style={{ color: ENF.ink }}>
                  {data ? money(data.cash.collectedToday) : "—"}
                </div>
                <div className="mt-1 text-[10.5px] font-medium uppercase tracking-wide" style={{ color: ENF.ink3 }}>
                  Today
                </div>
              </div>
              <div className="border-x px-1" style={{ borderColor: ENF.line }} data-testid="cash-stat-owed">
                <div className="text-lg font-bold leading-none" style={{ color: ENF.amber }}>
                  {data ? money(data.cash.owedToBank) : "—"}
                </div>
                <div className="mt-1 text-[10.5px] font-medium uppercase tracking-wide" style={{ color: ENF.ink3 }}>
                  Owed
                </div>
              </div>
              <div data-testid="cash-stat-reconciled">
                <div className="text-lg font-bold leading-none" style={{ color: ENF.green }}>
                  {data ? money(data.cash.reconciledTotal) : "—"}
                </div>
                <div className="mt-1 text-[10.5px] font-medium uppercase tracking-wide" style={{ color: ENF.ink3 }}>
                  Banked
                </div>
              </div>
            </div>

            {/* Per-attendant holdings */}
            {data && data.cash.holders.length > 0 && (
              <div className="mt-4 border-t pt-3" style={{ borderColor: ENF.line }}>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: ENF.ink3 }}>
                  Held by
                </div>
                <div className="space-y-2">
                  {data.cash.holders.map((h) => (
                    <div key={h.id} className="flex items-center justify-between" data-testid={`cash-holder-${h.id}`}>
                      <span className="flex items-center gap-2 text-[13px] font-medium" style={{ color: ENF.ink }}>
                        <Banknote className="h-4 w-4" style={{ color: ENF.amber }} />
                        {h.name}
                        <span className="text-[11px]" style={{ color: ENF.ink3 }}>· {h.count}</span>
                      </span>
                      <span className="text-[13px] font-bold" style={{ color: ENF.amber }}>{money(h.owed)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent cash entries */}
            {data && data.cash.recent.length > 0 && (
              <div className="mt-4 border-t pt-3" style={{ borderColor: ENF.line }}>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: ENF.ink3 }}>
                  Recent cash
                </div>
                <div className="space-y-2.5">
                  {data.cash.recent.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-2" data-testid={`cash-recent-${c.id}`}>
                      <div className="min-w-0">
                        <PlateText plate={c.licensePlate} size={14} />
                        <div className="mt-0.5 truncate text-[11px]" style={{ color: ENF.ink3 }}>
                          {c.collectedByName} · {relTime(c.collectedAt)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[13px] font-bold" style={{ color: ENF.ink }}>{money(c.amount)}</span>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                          style={
                            c.reconciled
                              ? { background: ENF.greenSoft, color: ENF.green }
                              : { background: ENF.amberSoft, color: ENF.amber }
                          }
                        >
                          {c.reconciled ? "Banked" : "Held"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data && data.cash.recent.length === 0 && (
              <div className="mt-3 border-t pt-3 text-center text-[12px]" style={{ borderColor: ENF.line, color: ENF.ink3 }} data-testid="cash-empty">
                No field cash logged yet.
              </div>
            )}
          </div>
        </section>

        {/* ===== 7-DAY TREND ===== */}
        <section data-testid="section-trend">
          <SectionLabel title="Last 7 days" right={
            <span className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: ENF.ink2 }}>
              <TrendingUp className="h-4 w-4" /> Boots / day
            </span>
          } />
          <div className="rounded-2xl border bg-white p-4" style={{ borderColor: ENF.line }}>
            {data ? (
              <>
                <div className="flex items-end justify-between gap-2" style={{ height: 120 }}>
                  {data.trend.map((t) => {
                    const h = Math.round((t.booted / maxBooted) * 96);
                    return (
                      <div key={t.day} className="flex flex-1 flex-col items-center gap-1.5">
                        <span className="text-[11px] font-bold" style={{ color: t.isToday ? ENF.orange : ENF.ink }}>
                          {t.booted}
                        </span>
                        <div className="flex w-full items-end justify-center" style={{ height: 96 }}>
                          <div
                            className="w-full rounded-md"
                            style={{
                              height: Math.max(4, h),
                              maxWidth: 26,
                              background: t.isToday ? ENF.orange : ENF.accent,
                              opacity: t.booted === 0 ? 0.18 : 1,
                            }}
                            data-testid={`trend-bar-${t.day}`}
                          />
                        </div>
                        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: t.isToday ? ENF.orange : ENF.ink3 }}>
                          {weekday(t.day)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex items-center justify-between border-t pt-3 text-[12px]" style={{ borderColor: ENF.line }}>
                  <span style={{ color: ENF.ink2 }}>7-day collected</span>
                  <span className="font-bold" style={{ color: ENF.green }} data-testid="trend-week-collected">
                    {money(data.trend.reduce((s, t) => s + t.collected, 0))}
                  </span>
                </div>
              </>
            ) : (
              <div className="h-[140px] animate-pulse rounded-lg" style={{ background: ENF.graySoft }} />
            )}
          </div>
        </section>

        {/* ===== THIS MONTH ROLLUP ===== */}
        <section data-testid="section-month">
          <SectionLabel title={data ? monthName(data.month.label) : "This month"} />
          <div className="grid grid-cols-2 gap-3">
            <TotalCard
              icon={<ParkingMeter className="h-[18px] w-[18px]" />}
              label="Cars booted"
              value={data ? String(data.month.booted) : null}
              tone="neutral"
              testid="kpi-month-booted"
            />
            <TotalCard
              icon={<DollarSign className="h-[18px] w-[18px]" />}
              label="Collected"
              value={data ? money(data.month.collected) : null}
              tone="paid"
              testid="kpi-month-collected"
            />
          </div>
        </section>

        {/* ===== TEAM & LOTS ===== */}
        <section data-testid="section-team-lots">
          <SectionLabel title="Team & lots" />
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border bg-white p-4" style={{ borderColor: ENF.line }} data-testid="card-staff">
              <div className="flex items-center gap-2" style={{ color: ENF.accent }}>
                <UsersIcon className="h-[18px] w-[18px]" />
                <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: ENF.ink2 }}>Staff</span>
              </div>
              <div className="mt-2 text-2xl font-bold leading-none">
                {data ? data.staff.active : "—"}<span className="text-sm font-semibold" style={{ color: ENF.ink3 }}> / {data ? data.staff.total : "—"}</span>
              </div>
              <div className="mt-1.5 text-[11.5px]" style={{ color: ENF.ink2 }}>
                {data ? `${data.staff.enforcers} enforcer · ${data.staff.attendants} attendant` : ""}
              </div>
            </div>
            <div className="rounded-2xl border bg-white p-4" style={{ borderColor: ENF.line }} data-testid="card-locations">
              <div className="flex items-center gap-2" style={{ color: ENF.accent }}>
                <MapPin className="h-[18px] w-[18px]" />
                <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: ENF.ink2 }}>Lots</span>
              </div>
              <div className="mt-2 text-2xl font-bold leading-none">
                {data ? data.locations.active : "—"}<span className="text-sm font-semibold" style={{ color: ENF.ink3 }}> / {data ? data.locations.total : "—"}</span>
              </div>
              <div className="mt-1.5 truncate text-[11.5px]" style={{ color: ENF.ink2 }}>
                {data ? data.locations.list.filter((l) => l.active).map((l) => l.name).slice(0, 2).join(", ") || "No active lots" : ""}
              </div>
            </div>
          </div>
        </section>

        {/* ===== RECENT ACTIVITY / PAID CARS (full data) ===== */}
        <section data-testid="section-recent">
          <SectionLabel
            title={recentMode === "activity" ? "Recent activity" : "Recent paid cars"}
            right={
              <span className="text-[11px] font-semibold" style={{ color: ENF.ink3 }}>
                {data
                  ? recentMode === "activity"
                    ? `${filteredRecent.length} shown`
                    : `${filteredPaid.length} shown`
                  : ""}
              </span>
            }
          />

          {/* Quick-search across both lists by plate / make-model / color. */}
          <div
            className="mb-3 flex items-center gap-2 rounded-full px-3"
            style={{ background: "#fff", border: `1px solid ${ENF.line}`, height: 42 }}
          >
            <SearchIcon className="h-[17px] w-[17px]" style={{ color: ENF.ink3 }} />
            <input
              value={recentSearch}
              onChange={(e) => setRecentSearch(e.target.value)}
              placeholder="Search plate or make/model"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
              style={{ color: ENF.ink }}
              data-testid="input-search-recent"
            />
            {recentSearch && (
              <button
                type="button"
                onClick={() => setRecentSearch("")}
                className="flex h-6 w-6 items-center justify-center rounded-full"
                style={{ color: ENF.ink3 }}
                aria-label="Clear search"
                data-testid="input-search-recent-clear"
              >
                <XIcon className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Two-way mode switch: Activity vs Paid cars */}
          <div
            className="mb-3 flex rounded-full p-1"
            style={{ background: "#fff", border: `1px solid ${ENF.line}` }}
            data-testid="recent-mode-switch"
          >
            {(["activity", "paid"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setRecentMode(m)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-[12.5px] font-semibold"
                style={
                  recentMode === m
                    ? { background: ENF.header, color: "#fff" }
                    : { background: "transparent", color: ENF.ink2 }
                }
                data-testid={`recent-mode-${m}`}
              >
                {m === "activity" ? (
                  <><Gavel className="h-3.5 w-3.5" /> Activity</>
                ) : (
                  <><Car className="h-3.5 w-3.5" /> Paid cars</>
                )}
              </button>
            ))}
          </div>

          {recentMode === "activity" && (
          <div className="mb-3 flex gap-1.5">
            {(["all", "active", "resolved"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setRecentFilter(f)}
                className="rounded-full px-3 py-1.5 text-[12px] font-semibold capitalize"
                style={
                  recentFilter === f
                    ? { background: ENF.header, color: "#fff" }
                    : { background: "#fff", color: ENF.ink2, border: `1px solid ${ENF.line}` }
                }
                data-testid={`filter-recent-${f}`}
              >
                {f}
              </button>
            ))}
          </div>
          )}

          {/* ----- ACTIVITY LIST ----- */}
          {recentMode === "activity" && (
          <div
            className="max-h-[440px] space-y-2.5 overflow-y-auto pr-0.5"
            style={{ overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}
            data-testid="recent-scroll"
          >
            {!data &&
              [0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[78px] animate-pulse rounded-2xl" style={{ background: "#fff", border: `1px solid ${ENF.line}` }} />
              ))}

            {data && filteredRecent.length === 0 && (
              <div className="rounded-2xl border bg-white px-4 py-8 text-center" style={{ borderColor: ENF.line }} data-testid="recent-empty">
                <p className="text-sm font-semibold">Nothing here yet</p>
                <p className="mt-1 text-[12.5px]" style={{ color: ENF.ink2 }}>No vehicles match this filter.</p>
              </div>
            )}

            {data &&
              filteredRecent.map((r) => {
                const lot = data.locations.list.find((l) => l.id === r.locationId);
                return (
                  <div
                    key={r.id}
                    className="rounded-2xl border bg-white p-3.5"
                    style={{ borderColor: r.paidConflict ? ENF.amber : ENF.line }}
                    data-testid={`card-recent-${r.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <PlateText plate={r.licensePlate} size={17} testid={`recent-plate-${r.id}`} />
                        <div className="mt-0.5 truncate text-[12.5px]" style={{ color: ENF.ink2 }}>
                          {[r.makeModel, r.color].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                      <StageBadge stage={r.stage} testid={`recent-stage-${r.id}`} />
                    </div>
                    <div className="mt-2.5 flex items-center justify-between border-t pt-2.5 text-[11.5px]" style={{ borderColor: ENF.line, color: ENF.ink3 }}>
                      <span className="truncate" data-testid={`recent-meta-${r.id}`}>
                        {lot ? `${lot.name} · ` : ""}{relTime(r.bootedAt)}
                        {r.lastActionByName ? ` · ${r.lastActionByName}` : ""}
                      </span>
                      <span className="shrink-0 font-bold" style={{ color: (r.amountCollected ?? 0) > 0 ? ENF.green : ENF.ink2 }}>
                        {(r.amountCollected ?? 0) > 0 ? money(r.amountCollected ?? 0) : money(r.bootFee)}
                      </span>
                    </div>
                    {r.paidConflict && (
                      <div className="mt-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold" style={{ background: ENF.amberSoft, color: ENF.amber }} data-testid={`recent-conflict-${r.id}`}>
                        <AlertTriangle className="h-3.5 w-3.5" /> Booted but appears paid — review
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
          )}

          {/* ----- PAID CARS LIST ----- */}
          {recentMode === "paid" && (
          <div
            className="max-h-[440px] space-y-2.5 overflow-y-auto pr-0.5"
            style={{ overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}
            data-testid="paid-scroll"
          >
            {!data &&
              [0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[72px] animate-pulse rounded-2xl" style={{ background: "#fff", border: `1px solid ${ENF.line}` }} />
              ))}

            {data && filteredPaid.length === 0 && (
              <div className="rounded-2xl border bg-white px-4 py-8 text-center" style={{ borderColor: ENF.line }} data-testid="paid-empty">
                <p className="text-sm font-semibold">{recentNeedle ? "No matching paid cars" : "No paid cars yet"}</p>
                <p className="mt-1 text-[12.5px]" style={{ color: ENF.ink2 }}>{recentNeedle ? "Try a different plate or make/model." : "Stripe and manual payments will appear here."}</p>
              </div>
            )}

            {data &&
              filteredPaid.map((c) => (
                <div
                  key={c.id}
                  className="rounded-2xl border bg-white p-3.5"
                  style={{ borderColor: ENF.line }}
                  data-testid={`card-paid-${c.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <PlateText plate={c.licensePlate} size={17} testid={`paid-plate-${c.id}`} />
                      <div className="mt-0.5 truncate text-[12.5px]" style={{ color: ENF.ink2 }}>
                        {[c.makeModel, c.color].filter(Boolean).join(" · ") || "—"}
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
                      {c.source === "stripe" ? "Stripe" : c.method === "cash" ? "Cash" : "Manual"}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between gap-2 border-t pt-2.5 text-[11.5px]" style={{ borderColor: ENF.line, color: ENF.ink3 }}>
                    <span className="truncate" data-testid={`paid-meta-${c.id}`}>
                      {c.space ? `${c.space} · ` : ""}{relTime(c.paidAt)}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-bold" style={{ color: (c.amount ?? 0) > 0 ? ENF.green : ENF.ink2 }}>
                        {c.amount != null ? money(c.amount) : "—"}
                      </span>
                      {c.source === "manual" && (
                        <button
                          type="button"
                          onClick={() => deletePaidMutation.mutate(c.id)}
                          disabled={deletePaidMutation.isPending}
                          className="flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-50"
                          style={{ color: ENF.ink3 }}
                          data-testid={`button-delete-paid-${c.id}`}
                          aria-label="Delete manual paid entry"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </div>
          )}
        </section>

        <p className="pt-2 text-center text-[11px]" style={{ color: ENF.ink3 }} data-testid="admin-preview-footnote">
          Live read-only management view · refreshes every 30s
        </p>
        </>
        )}

        {/* ======================= CHARTS TAB ======================= */}
        {tab === "charts" && (
          <ComingSoonPage
            icon={<BarChart3 className="h-7 w-7" />}
            title="Charts & analytics"
            blurb="In-depth management charts are coming here — booting and collection trends, payment mix (Stripe vs cash), per-lot performance, and reconciliation over time."
            bullets={[
              "Revenue & collections over time",
              "Payment method breakdown",
              "Per-lot and per-staff performance",
              "Cash reconciliation trends",
            ]}
          />
        )}

        {/* ======================= HISTORY TAB ======================= */}
        {tab === "history" && (
          <ComingSoonPage
            icon={<HistoryIcon className="h-7 w-7" />}
            title="Historical data"
            blurb="Expanded historical records are coming here — searchable archives of boots, payments, and cash collections going back beyond the 7-day window."
            bullets={[
              "Full boot & release history",
              "Payment & cash ledgers by date range",
              "Searchable / filterable archive",
              "Exportable records",
            ]}
          />
        )}

        {/* ======================= SETTINGS TAB ======================= */}
        {tab === "settings" && (
          <ComingSoonPage
            icon={<SettingsIcon className="h-7 w-7" />}
            title="Settings"
            blurb="Expanded admin settings are coming here — manage lots, staff, fee rules, payment configuration, and reconciliation preferences."
            bullets={[
              "Lots & location management",
              "Staff roles & permissions",
              "Boot fee & pricing rules",
              "Payment & reconciliation config",
            ]}
          />
        )}
      </main>

      {/* ===== BOTTOM TAB BAR ===== */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex items-stretch border-t"
        style={{ background: "#fff", borderColor: ENF.line, paddingBottom: "env(safe-area-inset-bottom)" }}
        data-testid="admin-tabbar"
      >
        {([
          { id: "dashboard" as const, label: "Dashboard", icon: LayoutDashboard },
          { id: "charts" as const, label: "Charts", icon: BarChart3 },
          { id: "history" as const, label: "History", icon: HistoryIcon },
          { id: "settings" as const, label: "Settings", icon: SettingsIcon },
        ]).map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className="flex flex-1 flex-col items-center justify-center gap-1 py-2.5"
              style={{ color: active ? ENF.orange : ENF.ink3, minHeight: 56 }}
              data-testid={`tab-${id}`}
              aria-label={label}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-[21px] w-[21px]" strokeWidth={active ? 2.4 : 1.9} />
              <span className="text-[10.5px] font-semibold">{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function ComingSoonPage({
  icon,
  title,
  blurb,
  bullets,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  bullets: string[];
}) {
  return (
    <section className="pt-4" data-testid={`page-${title.split(" ")[0].toLowerCase()}`}>
      <div
        className="rounded-2xl border bg-white p-6 text-center"
        style={{ borderColor: ENF.line }}
      >
        <span
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{ background: ENF.accentSoft, color: ENF.accent }}
        >
          {icon}
        </span>
        <h2 className="mt-4 text-lg font-bold" style={{ color: ENF.ink }}>{title}</h2>
        <span
          className="mt-2 inline-block rounded-full px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide"
          style={{ background: ENF.amberSoft, color: ENF.amber }}
        >
          Coming soon
        </span>
        <p className="mx-auto mt-3 max-w-[300px] text-[13px] leading-snug" style={{ color: ENF.ink2 }}>
          {blurb}
        </p>
      </div>
      <div
        className="mt-4 rounded-2xl border bg-white p-4"
        style={{ borderColor: ENF.line }}
      >
        <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: ENF.ink3 }}>
          Planned
        </div>
        <div className="space-y-2.5">
          {bullets.map((b) => (
            <div key={b} className="flex items-center gap-2.5 text-[13px]" style={{ color: ENF.ink }}>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg" style={{ background: ENF.graySoft, color: ENF.ink3 }}>
                <Clock className="h-3.5 w-3.5" />
              </span>
              {b}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionLabel({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.06em]" style={{ color: ENF.ink2 }}>{title}</h2>
      {right}
    </div>
  );
}

type Tone = "neutral" | "paid" | "info" | "active" | "review";

function toneColors(tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case "paid":
      return { fg: ENF.green, bg: ENF.greenSoft };
    case "active":
      return { fg: ENF.red, bg: ENF.redSoft };
    case "review":
      return { fg: ENF.amber, bg: ENF.amberSoft };
    case "info":
      return { fg: ENF.blue, bg: ENF.blueSoft };
    case "neutral":
    default:
      return { fg: ENF.accent, bg: ENF.accentSoft };
  }
}

function TotalCard({
  icon,
  label,
  value,
  tone,
  testid,
  sublabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  tone: Tone;
  testid?: string;
  sublabel?: string;
}) {
  const { fg, bg } = toneColors(tone);
  return (
    <div className="rounded-2xl border bg-white p-4" style={{ borderColor: ENF.line }} data-testid={testid}>
      <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: bg, color: fg }}>{icon}</span>
      {value === null ? (
        <div className="mt-3 h-7 w-16 animate-pulse rounded" style={{ background: ENF.graySoft }} />
      ) : (
        <div className="mt-3 text-2xl font-bold leading-none" style={{ color: tone === "paid" ? ENF.green : ENF.ink }}>{value}</div>
      )}
      <div className="mt-1.5 text-[12px] font-medium leading-tight" style={{ color: ENF.ink2 }}>{label}</div>
      {sublabel && (
        <div className="mt-0.5 text-[10.5px] font-medium" style={{ color: ENF.ink3 }}>{sublabel}</div>
      )}
    </div>
  );
}

function TrackerCard({
  icon,
  label,
  value,
  tone,
  testid,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  tone: Tone;
  testid?: string;
}) {
  const { fg, bg } = toneColors(tone);
  const elevated = value !== null && value > 0 && tone !== "neutral";
  return (
    <div
      className="rounded-2xl border p-4"
      style={{
        borderColor: elevated ? fg : ENF.line,
        background: elevated ? bg : "#fff",
      }}
      data-testid={testid}
    >
      <div className="flex items-center justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: elevated ? "#fff" : bg, color: fg }}>{icon}</span>
        {value === null ? (
          <div className="h-7 w-8 animate-pulse rounded" style={{ background: ENF.graySoft }} />
        ) : (
          <span className="text-3xl font-bold leading-none" style={{ color: elevated ? fg : ENF.ink }}>{value}</span>
        )}
      </div>
      <div className="mt-2.5 text-[12px] font-medium" style={{ color: elevated ? fg : ENF.ink2 }}>{label}</div>
    </div>
  );
}
