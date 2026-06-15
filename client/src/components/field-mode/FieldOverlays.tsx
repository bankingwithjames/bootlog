import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  X,
  CheckCircle2,
  XCircle,
  Banknote,
  Settings as SettingsIcon,
  Clock,
  LogOut,
  KeyRound,
  CalendarCheck,
  Megaphone,
  Monitor,
  Eye,
  EyeOff,
} from "lucide-react";
import { useDiscretion, toggleDiscretion } from "@/lib/discretion";
import type {
  BootRequest,
  ReleaseRequest,
  Shift,
  CashSummary,
} from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { FIELD, FIELD_FONT, FIELD_MONO } from "./FieldShell";

// ---------------------------------------------------------------------------
// Field Mode overlays + dashboard widgets (attendant-only).
//   - useFieldNotifications: derives the attendant's OWN resolved boot/release
//     requests into a single notification feed (drives the bell + dot).
//   - useCashSummary: the attendant's running cash-owed total.
//   - NotificationCenter: bell popup sheet.
//   - AccountMenu: hamburger sheet (Settings + Time Sheet).
//   - AttendantWidget: centered dashboard card (confirmations + alerts + cash).
//   - CashTracker: standalone running-cash card.
// All chrome stays within Field Mode so admin/enforcer UIs are untouched.
// ---------------------------------------------------------------------------

function currency(n: number): string {
  return (Number(n) || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// Tailwind classes applied to a sensitive figure when discretion mode is ON.
// The number stays in the layout (so spacing/size is identical) but is blurred
// so a guest standing nearby can't read it; `select-none` stops accidental
// text-selection from revealing it. Admin/enforcer UIs never call this.
const DISCREET_CLASS = "blur-[6px] select-none";
function discreetCls(on: boolean): string {
  return on ? ` ${DISCREET_CLASS}` : "";
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const then = parseISO(iso).getTime();
    const diff = Date.now() - then;
    const mins = Math.round(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return format(parseISO(iso), "MMM d, h:mm a");
  } catch {
    return "";
  }
}

// A single normalized notification item shown in the bell center + widget.
export type FieldNotification = {
  id: string;
  kind: "boot" | "release";
  // "approved" (boot placed / boot released) or "declined" (dismissed).
  outcome: "approved" | "declined";
  title: string;
  detail: string;
  plate: string;
  byName: string;
  at: string | null;
};

// Pull the attendant's OWN boot + release requests and surface the ones an
// enforcer/admin has resolved as notifications. Polls so a reply shows up
// without a manual refresh.
export function useFieldNotifications(userId: number | null) {
  const bootQuery = useQuery<BootRequest[]>({
    queryKey: ["/api/boot-requests"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/boot-requests");
      return res.json();
    },
    refetchInterval: 45_000,
    staleTime: 20_000,
  });
  const releaseQuery = useQuery<ReleaseRequest[]>({
    queryKey: ["/api/release-requests"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/release-requests");
      return res.json();
    },
    refetchInterval: 45_000,
    staleTime: 20_000,
  });

  const notifications = useMemo<FieldNotification[]>(() => {
    const out: FieldNotification[] = [];
    const boots = bootQuery.data ?? [];
    const releases = releaseQuery.data ?? [];

    for (const r of boots) {
      if (userId != null && r.requestedById !== userId) continue;
      // Only resolved boot requests carry a reply to show the attendant.
      if (r.status !== "initiated" && r.status !== "dismissed") continue;
      const approved = r.status === "initiated";
      out.push({
        id: `boot-${r.id}`,
        kind: "boot",
        outcome: approved ? "approved" : "declined",
        title: approved ? "Boot request approved" : "Boot request declined",
        detail: approved
          ? "An enforcer placed the boot you requested."
          : "An enforcer declined your boot request.",
        plate: r.licensePlate,
        byName: r.resolvedByName ?? "Enforcer",
        at: r.resolvedAt ?? null,
      });
    }

    for (const r of releases) {
      if (userId != null && r.requestedById !== userId) continue;
      if (r.status !== "released" && r.status !== "dismissed") continue;
      const approved = r.status === "released";
      out.push({
        id: `release-${r.id}`,
        kind: "release",
        outcome: approved ? "approved" : "declined",
        title: approved ? "Boot release approved" : "Release request declined",
        detail: approved
          ? "The boot you flagged was released."
          : "Your boot-release request was declined.",
        plate: r.licensePlate,
        byName: r.resolvedByName ?? "Enforcer",
        at: r.resolvedAt ?? null,
      });
    }

    out.sort((a, b) => {
      const ta = a.at ? parseISO(a.at).getTime() : 0;
      const tb = b.at ? parseISO(b.at).getTime() : 0;
      return tb - ta;
    });
    return out;
  }, [bootQuery.data, releaseQuery.data, userId]);

  return {
    notifications,
    hasUnread: notifications.length > 0,
    isLoading: bootQuery.isLoading || releaseQuery.isLoading,
  };
}

// The attendant's running cash total (cash they've logged and still owe admin).
export function useCashSummary() {
  return useQuery<CashSummary>({
    queryKey: ["/api/cash/mine"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/cash/mine");
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 20_000,
  });
}

// ---------------------------------------------------------------------------
// Shared sheet shell (bottom sheet over a dim scrim).
// ---------------------------------------------------------------------------
function SheetShell({
  title,
  icon,
  onClose,
  children,
  testid,
}: {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  testid: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      style={{ background: "rgba(8,18,32,.55)", fontFamily: FIELD_FONT }}
      onClick={onClose}
      data-testid={testid}
    >
      <div
        className="max-h-[80vh] overflow-y-auto rounded-t-[20px] bg-white pb-[max(20px,env(safe-area-inset-bottom))]"
        style={{ boxShadow: "0 -12px 40px rgba(8,18,32,.28)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="sticky top-0 flex items-center justify-between rounded-t-[20px] bg-white px-[18px] pb-3 pt-[18px]"
          style={{ borderBottom: `1px solid ${FIELD.line}` }}
        >
          <div className="flex items-center gap-2 text-[15px] font-bold" style={{ color: FIELD.ink }}>
            <span style={{ color: FIELD.accent }}>{icon}</span>
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full"
            style={{ background: FIELD.fieldBg, color: FIELD.ink2 }}
            data-testid="button-sheet-close"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
        <div className="px-[18px] pt-3">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notification center (bell popup).
// ---------------------------------------------------------------------------
export function NotificationCenter({
  notifications,
  onClose,
}: {
  notifications: FieldNotification[];
  onClose: () => void;
}) {
  return (
    <SheetShell
      title="Notifications"
      icon={<Bell className="h-[18px] w-[18px]" />}
      onClose={onClose}
      testid="field-notification-center"
    >
      <div className="mb-1 text-[12px] font-medium" style={{ color: FIELD.ink3 }}>
        Replies from your enforcer &amp; admin
      </div>
      {notifications.length === 0 ? (
        <div
          className="my-3 flex flex-col items-center gap-2 rounded-[14px] px-4 py-10 text-center"
          style={{ background: FIELD.fieldBg, border: `1px dashed ${FIELD.line}` }}
          data-testid="field-notifications-empty"
        >
          <Bell className="h-7 w-7" style={{ color: FIELD.ink3 }} />
          <div className="text-[13px] font-semibold" style={{ color: FIELD.ink2 }}>
            You're all caught up
          </div>
          <div className="text-[12px]" style={{ color: FIELD.ink3 }}>
            Replies to your boot &amp; release requests show up here.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 pb-1">
          {notifications.map((n) => {
            const approved = n.outcome === "approved";
            const accent = approved ? "#1f7a44" : "#c0392b";
            const fill = approved ? "#e4f4ea" : "#fdecea";
            return (
              <div
                key={n.id}
                className="flex gap-3 rounded-[14px] px-3.5 py-3"
                style={{ background: "#fff", border: `1px solid ${FIELD.line}`, borderLeft: `3px solid ${accent}` }}
                data-testid={`field-notification-${n.id}`}
              >
                <div
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                  style={{ background: fill, color: accent }}
                >
                  {approved ? (
                    <CheckCircle2 className="h-[18px] w-[18px]" />
                  ) : (
                    <XCircle className="h-[18px] w-[18px]" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-bold" style={{ color: FIELD.ink }}>
                      {n.title}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12.5px]" style={{ color: FIELD.ink2 }}>
                    {n.detail}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className="rounded-md px-1.5 py-0.5 text-[11px] font-bold tracking-[0.04em] text-white"
                      style={{ fontFamily: FIELD_MONO, background: "#1a1d24", border: "1px solid #333" }}
                    >
                      {n.plate}
                    </span>
                    <span className="text-[11px]" style={{ color: FIELD.ink3 }}>
                      {n.byName}
                      {n.at ? ` · ${timeAgo(n.at)}` : ""}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SheetShell>
  );
}

// ---------------------------------------------------------------------------
// Account / hamburger menu — Settings + Time Sheet records.
// ---------------------------------------------------------------------------
export function AccountMenu({
  userName,
  onClose,
  changePassword,
  onLogout,
  onSwitchToDesktop,
}: {
  userName: string;
  onClose: () => void;
  changePassword: (current: string, next: string) => Promise<void>;
  onLogout: () => void;
  onSwitchToDesktop?: () => void;
}) {
  const [pwOpen, setPwOpen] = useState(false);
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwOk, setPwOk] = useState(false);

  async function submitPw() {
    setPwErr(null);
    if (newPw.length < 8) {
      setPwErr("New password must be at least 8 characters.");
      return;
    }
    setPwBusy(true);
    try {
      await changePassword(curPw, newPw);
      setPwOk(true);
      setCurPw("");
      setNewPw("");
    } catch (e: any) {
      setPwErr(e?.message?.replace(/^\d+:\s*/, "") || "Could not change password.");
    } finally {
      setPwBusy(false);
    }
  }
  const shiftsQuery = useQuery<{ shifts: Shift[] }>({
    queryKey: ["/api/shifts/mine"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/shifts/mine");
      return res.json();
    },
    staleTime: 30_000,
  });
  const shifts = shiftsQuery.data?.shifts ?? [];

  function shiftDuration(s: Shift): string {
    if (!s.checkOutAt) return "Open";
    try {
      const ms = parseISO(s.checkOutAt).getTime() - parseISO(s.checkInAt).getTime();
      const mins = Math.max(0, Math.round(ms / 60000));
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    } catch {
      return "—";
    }
  }
  function shiftRange(s: Shift): string {
    try {
      const inT = format(parseISO(s.checkInAt), "MMM d · h:mm a");
      const outT = s.checkOutAt ? format(parseISO(s.checkOutAt), "h:mm a") : "now";
      return `${inT} – ${outT}`;
    } catch {
      return "";
    }
  }

  return (
    <SheetShell
      title="Menu"
      icon={<SettingsIcon className="h-[18px] w-[18px]" />}
      onClose={onClose}
      testid="field-account-menu"
    >
      {/* Account row */}
      <div
        className="mb-4 flex items-center gap-3 rounded-[14px] px-3.5 py-3"
        style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
      >
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full text-[15px] font-bold text-white"
          style={{ background: FIELD.header }}
        >
          {(userName || "A").charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-bold" style={{ color: FIELD.ink }} data-testid="menu-user-name">
            {userName}
          </div>
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.05em]" style={{ color: FIELD.ink3 }}>
            Attendant
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.05em]" style={{ color: FIELD.ink3 }}>
        <SettingsIcon className="h-3.5 w-3.5" /> Settings
      </div>
      <div
        className="mb-4 overflow-hidden rounded-[14px]"
        style={{ background: "#fff", border: `1px solid ${FIELD.line}` }}
        data-testid="menu-settings"
      >
        {onSwitchToDesktop && (
          <button
            type="button"
            onClick={onSwitchToDesktop}
            className="flex w-full items-center justify-between px-3.5 py-3 text-left"
            style={{ borderBottom: `1px solid ${FIELD.line}` }}
            data-testid="button-menu-switch-desktop"
          >
            <span className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: FIELD.ink }}>
              <Monitor className="h-4 w-4" style={{ color: FIELD.accent }} /> Switch to desktop view
            </span>
            <span className="text-[12px]" style={{ color: FIELD.ink3 }}>›</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setPwOpen((v) => !v);
            setPwOk(false);
            setPwErr(null);
          }}
          className="flex w-full items-center justify-between px-3.5 py-3 text-left"
          style={{ borderBottom: `1px solid ${FIELD.line}` }}
          data-testid="button-menu-change-password"
        >
          <span className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: FIELD.ink }}>
            <KeyRound className="h-4 w-4" style={{ color: FIELD.accent }} /> Change password
          </span>
          <span className="text-[12px]" style={{ color: FIELD.ink3 }}>{pwOpen ? "−" : "+"}</span>
        </button>
        {pwOpen && (
          <div className="flex flex-col gap-2 px-3.5 py-3" style={{ borderBottom: `1px solid ${FIELD.line}`, background: FIELD.fieldBg }} data-testid="menu-change-password-form">
            {pwOk ? (
              <div className="flex items-center gap-2 text-[12.5px] font-semibold" style={{ color: "#1f7a44" }} data-testid="menu-password-success">
                <CheckCircle2 className="h-4 w-4" /> Password updated.
              </div>
            ) : (
              <>
                <input
                  type="password"
                  value={curPw}
                  onChange={(e) => setCurPw(e.target.value)}
                  placeholder="Current password"
                  className="rounded-[10px] px-3 py-2.5 text-[13px] outline-none"
                  style={{ background: "#fff", border: `1px solid ${FIELD.line}`, color: FIELD.ink }}
                  data-testid="input-current-password"
                />
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  className="rounded-[10px] px-3 py-2.5 text-[13px] outline-none"
                  style={{ background: "#fff", border: `1px solid ${FIELD.line}`, color: FIELD.ink }}
                  data-testid="input-new-password"
                />
                {pwErr && (
                  <div className="text-[12px] font-medium" style={{ color: "#c0392b" }} data-testid="menu-password-error">
                    {pwErr}
                  </div>
                )}
                <button
                  type="button"
                  onClick={submitPw}
                  disabled={pwBusy || !curPw || !newPw}
                  className="rounded-[10px] px-3 py-2.5 text-[13px] font-bold text-white disabled:opacity-50"
                  style={{ background: FIELD.accent }}
                  data-testid="button-submit-password"
                >
                  {pwBusy ? "Saving…" : "Update password"}
                </button>
              </>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center justify-between px-3.5 py-3 text-left"
          data-testid="button-menu-logout"
        >
          <span className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: "#c0392b" }}>
            <LogOut className="h-4 w-4" /> Log out
          </span>
        </button>
      </div>

      {/* Time Sheet */}
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.05em]" style={{ color: FIELD.ink3 }}>
        <Clock className="h-3.5 w-3.5" /> Time Sheet
      </div>
      <div
        className="mb-2 overflow-hidden rounded-[14px]"
        style={{ background: "#fff", border: `1px solid ${FIELD.line}` }}
        data-testid="menu-timesheet"
      >
        {shiftsQuery.isLoading ? (
          <div className="px-3.5 py-6 text-center text-[13px]" style={{ color: FIELD.ink3 }}>
            Loading shifts…
          </div>
        ) : shifts.length === 0 ? (
          <div className="px-3.5 py-8 text-center text-[13px]" style={{ color: FIELD.ink3 }} data-testid="menu-timesheet-empty">
            No shifts recorded yet.
          </div>
        ) : (
          shifts.map((s, i) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-2 px-3.5 py-3"
              style={{ borderBottom: i === shifts.length - 1 ? "none" : `1px solid ${FIELD.line}` }}
              data-testid={`menu-shift-${s.id}`}
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold" style={{ color: FIELD.ink }}>
                  {s.locationName || "Lot"}
                </div>
                <div className="mt-0.5 text-[11.5px]" style={{ color: FIELD.ink3 }}>
                  {shiftRange(s)}
                </div>
              </div>
              <span
                className="shrink-0 rounded-full px-2 py-1 text-[11px] font-bold"
                style={
                  s.checkOutAt
                    ? { background: FIELD.fieldBg, color: FIELD.ink2 }
                    : { background: "rgba(63,207,134,.15)", color: "#1f7a44" }
                }
              >
                {shiftDuration(s)}
              </span>
            </div>
          ))
        )}
      </div>
    </SheetShell>
  );
}

// ---------------------------------------------------------------------------
// Attendant dashboard widget — centered card for the empty home zone.
// Shows: reservation/boot confirmations + messages/alerts (mirrors the bell)
// and the running cash-owed total. Attendant-specific.
// ---------------------------------------------------------------------------
export function AttendantWidget({
  notifications,
  cash,
  onOpenNotifications,
}: {
  notifications: FieldNotification[];
  cash: CashSummary | undefined;
  onOpenNotifications: () => void;
}) {
  const top = notifications.slice(0, 3);
  const owed = cash?.owedTotal ?? 0;
  const owedCount = cash?.owedCount ?? 0;
  const discreet = useDiscretion();

  return (
    <section
      className="overflow-hidden rounded-[16px]"
      style={{ background: "#fff", border: `1px solid ${FIELD.line}`, boxShadow: "0 2px 10px rgba(16,36,63,.05)" }}
      data-testid="field-attendant-widget"
    >
      {/* Header band */}
      <div
        className="flex items-center justify-between px-4 py-3 text-white"
        style={{ background: `linear-gradient(135deg, ${FIELD.header}, ${FIELD.header2})` }}
      >
        <div className="flex items-center gap-2 text-[13.5px] font-bold">
          <Megaphone className="h-[18px] w-[18px]" /> Your dashboard
        </div>
        <div className="flex items-center gap-2.5">
          {/* Discretion toggle — blurs the cash figures from nearby guests.
              Visual only; does not change permissions or hide data. */}
          <button
            type="button"
            onClick={toggleDiscretion}
            aria-pressed={discreet}
            title={discreet ? "Show cash figures" : "Hide cash figures from view"}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors"
            style={{
              background: discreet ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.16)",
              color: discreet ? FIELD.header : "#fff",
            }}
            data-testid="button-discretion-toggle"
          >
            {discreet ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {discreet ? "Hidden" : "Hide"}
          </button>
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-white/60">
            Attendant
          </span>
        </div>
      </div>

      {/* Cash-owed running total */}
      <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: `1px solid ${FIELD.line}` }}>
        <div
          className="flex h-11 w-11 items-center justify-center rounded-[12px]"
          style={{ background: "rgba(232,86,10,.1)", color: FIELD.orange }}
        >
          <Banknote className="h-[22px] w-[22px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em]" style={{ color: FIELD.ink3 }}>
            Cash owed to bank
          </div>
          <div
            className={`text-[22px] font-extrabold leading-tight${discreetCls(discreet)}`}
            style={{ fontFamily: FIELD_MONO, color: FIELD.ink }}
            data-testid="widget-cash-owed"
          >
            {currency(owed)}
          </div>
        </div>
        <span
          className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold"
          style={{ background: FIELD.fieldBg, color: FIELD.ink2 }}
          data-testid="widget-cash-count"
        >
          {owedCount} {owedCount === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* Messages / alerts */}
      <div className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.05em]" style={{ color: FIELD.ink3 }}>
            <Bell className="h-3.5 w-3.5" /> Messages &amp; alerts
          </span>
          <button
            type="button"
            onClick={onOpenNotifications}
            className="text-[12px] font-semibold"
            style={{ color: FIELD.accent }}
            data-testid="widget-open-notifications"
          >
            View all ›
          </button>
        </div>
        {top.length === 0 ? (
          <div
            className="flex items-center gap-2 rounded-[12px] px-3 py-3 text-[12.5px]"
            style={{ background: FIELD.fieldBg, color: FIELD.ink3 }}
            data-testid="widget-alerts-empty"
          >
            <CalendarCheck className="h-[18px] w-[18px]" />
            No new confirmations or alerts. You're all set.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {top.map((n) => {
              const approved = n.outcome === "approved";
              const accent = approved ? "#1f7a44" : "#c0392b";
              const fill = approved ? "#e4f4ea" : "#fdecea";
              return (
                <button
                  type="button"
                  key={n.id}
                  onClick={onOpenNotifications}
                  className="flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left"
                  style={{ background: FIELD.fieldBg, border: `1px solid ${FIELD.line}` }}
                  data-testid={`widget-alert-${n.id}`}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                    style={{ background: fill, color: accent }}
                  >
                    {approved ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold" style={{ color: FIELD.ink }}>
                      {n.title}
                    </span>
                    <span className="block truncate text-[11px]" style={{ color: FIELD.ink3 }}>
                      {n.plate} · {timeAgo(n.at)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cash tracker — standalone running-total card (recent cash entries).
// ---------------------------------------------------------------------------
// Module-level memory of the last reconciliation timestamp the attendant has
// already acknowledged (dismissed). Kept in a module variable rather than
// localStorage/sessionStorage to satisfy the no-client-storage compliance rule.
// It survives component remounts within a session but resets on full reload —
// acceptable, since a reload re-shows the latest verification confirmation.
let acknowledgedReconciledAt: string | null = null;

export function CashTracker({ cash }: { cash: CashSummary | undefined }) {
  const owed = cash?.owedTotal ?? 0;
  const reconciled = cash?.reconciledTotal ?? 0;
  // Show EVERY unverified (owed) cash entry — no truncation. The list scrolls
  // and stays until an admin / permitted user verifies the count (which
  // reconciles the entries and drops them out of this unverified view).
  const unverified = (cash?.recent ?? []).filter((c) => !c.reconciled);
  const owedCount = cash?.owedCount ?? unverified.length;
  const discreet = useDiscretion();

  // "Cash verified by <admin> — count reset" confirmation banner. Shows when
  // the backend reports a reconciliation timestamp the attendant hasn't yet
  // dismissed. State is seeded from the module-level ack so the banner stays
  // dismissed across remounts but reappears for a newer verification.
  const lastReconciledAt = cash?.lastReconciledAt ?? null;
  const lastReconciledByName = cash?.lastReconciledByName ?? null;
  const [ackedAt, setAckedAt] = useState<string | null>(acknowledgedReconciledAt);
  const showVerifiedBanner =
    !!lastReconciledAt && lastReconciledAt !== ackedAt;
  const dismissVerifiedBanner = () => {
    acknowledgedReconciledAt = lastReconciledAt;
    setAckedAt(lastReconciledAt);
  };

  return (
    <section data-testid="field-cash-tracker">
      {showVerifiedBanner && (
        <div
          className="mb-2 flex items-start gap-2.5 rounded-[12px] px-3 py-2.5"
          style={{ background: "#e7f6ee", border: "1px solid #15924f33" }}
          data-testid="cash-verified-banner"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#15924f" }} />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-bold" style={{ color: "#0f6b39" }}>
              {lastReconciledByName
                ? `Cash verified by ${lastReconciledByName} — count reset`
                : "Cash verified — count reset"}
            </div>
            <div className="text-[11px]" style={{ color: "#2f8a5c" }}>
              {timeAgo(lastReconciledAt)} · your verified entries cleared from the unverified list.
            </div>
          </div>
          <button
            type="button"
            onClick={dismissVerifiedBanner}
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-0.5"
            style={{ color: "#2f8a5c" }}
            data-testid="cash-verified-banner-dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[13px] font-bold" style={{ color: FIELD.ink }}>
          <Banknote className="h-4 w-4" style={{ color: FIELD.orange }} /> Cash tracker
        </div>
        {owedCount > 0 && (
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-bold"
            style={{ background: "#fff3ea", color: FIELD.orange, border: `1px solid ${FIELD.orange}33` }}
            data-testid="cash-unverified-count"
          >
            {owedCount} unverified
          </span>
        )}
      </div>
      <div
        className="overflow-hidden rounded-[14px]"
        style={{ background: "#fff", border: `1px solid ${FIELD.line}` }}
      >
        <div className="grid grid-cols-2">
          <div className="px-3.5 py-3" style={{ borderRight: `1px solid ${FIELD.line}`, borderBottom: `1px solid ${FIELD.line}` }}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: FIELD.ink3 }}>
              Owed (unverified)
            </div>
            <div className={`text-[18px] font-extrabold${discreetCls(discreet)}`} style={{ fontFamily: FIELD_MONO, color: FIELD.orange }} data-testid="cash-owed-total">
              {currency(owed)}
            </div>
          </div>
          <div className="px-3.5 py-3" style={{ borderBottom: `1px solid ${FIELD.line}` }}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: FIELD.ink3 }}>
              Reconciled
            </div>
            <div className={`text-[18px] font-extrabold${discreetCls(discreet)}`} style={{ fontFamily: FIELD_MONO, color: "#1f7a44" }} data-testid="cash-reconciled-total">
              {currency(reconciled)}
            </div>
          </div>
        </div>
        {unverified.length === 0 ? (
          <div className="px-3.5 py-6 text-center text-[12.5px]" style={{ color: FIELD.ink3 }} data-testid="cash-recent-empty">
            No unverified cash. Record a cash payment to start your running total.
          </div>
        ) : (
          <>
            {/* Column header for the scrollable unverified table. */}
            <div
              className="flex items-center gap-2.5 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.05em]"
              style={{ color: FIELD.ink3, background: "#fafbfc", borderBottom: `1px solid ${FIELD.line}` }}
            >
              <span className="shrink-0" style={{ width: 64 }}>Plate</span>
              <span className="min-w-0 flex-1">Vehicle</span>
              <span className="shrink-0">Amount</span>
            </div>
            {/* Scroll region — shows ALL unverified entries; scrolls past ~5 rows. */}
            <div
              className="overflow-y-auto overscroll-contain"
              style={{ maxHeight: 264 }}
              data-testid="cash-unverified-scroll"
            >
              {unverified.map((c, i) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2.5 px-3.5 py-2.5"
                  style={{ borderBottom: i === unverified.length - 1 ? "none" : `1px solid ${FIELD.line}` }}
                  data-testid={`cash-row-${c.id}`}
                >
                  <span
                    className="shrink-0 rounded-md px-1.5 py-1 text-center text-[11.5px] font-bold tracking-[0.04em] text-white"
                    style={{ fontFamily: FIELD_MONO, background: "#1a1d24", border: "1px solid #333", width: 64 }}
                  >
                    {c.licensePlate}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold" style={{ color: FIELD.ink }}>
                      {c.makeModel || "Vehicle"}
                    </span>
                    <span className="block text-[11px]" style={{ color: FIELD.ink3 }}>
                      {timeAgo(c.collectedAt)}
                    </span>
                  </span>
                  <span className={`shrink-0 text-[13px] font-extrabold${discreetCls(discreet)}`} style={{ fontFamily: FIELD_MONO, color: FIELD.ink }}>
                    {currency(c.amount)}
                  </span>
                </div>
              ))}
            </div>
            {/* Footer note — the list clears once an admin verifies the count. */}
            <div
              className="px-3.5 py-2 text-[10.5px]"
              style={{ color: FIELD.ink3, background: "#fafbfc", borderTop: `1px solid ${FIELD.line}` }}
            >
              Stays until an admin verifies the count.
            </div>
          </>
        )}
      </div>
    </section>
  );
}
