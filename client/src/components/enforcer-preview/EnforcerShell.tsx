import type { ReactNode } from "react";
import {
  Bell,
  Menu,
  MapPin,
  Home as HomeIcon,
  Search as SearchIcon,
  ListChecks,
  Clock,
  Camera,
} from "lucide-react";
import logoMark from "@assets/logo-mark.png";
import type { EnforcementStage } from "@shared/schema";
import { ENFORCEMENT_STAGE_META } from "@shared/schema";

// =============================================================================
// Enforcer Mobile Preview — Shell + shared design tokens (preview-only)
// =============================================================================
// Mirrors the attendant Field Mode visual language (FieldShell) but with an
// enforcer-specific bottom nav: Home / Lookup / Queue / History / Profile, plus
// a raised "Scan plate" FAB. Kept entirely separate from FieldShell so the live
// attendant chrome is untouched.

export type EnforcerView =
  | "home"
  | "lookup"
  | "queue"
  | "history"
  | "profile"
  | "case"
  | "evidence"
  | "payment";

// Field palette — reuses the attendant Signal Blue tokens for consistency, with
// the plan's semantic status colors layered on top for stage badges.
export const ENF = {
  orange: "#E8560A",
  accent: "#1f6feb",
  accentSoft: "#e8f0fe",
  accentInk: "#1551b8",
  header: "#10243f",
  header2: "#1b3a63",
  ink: "#0d1b2a",
  ink2: "#5c6b7a",
  ink3: "#94a1ad",
  line: "#e7ebf0",
  fieldBg: "#f4f7fa",
  // Semantic status families (plan §color system)
  green: "#15924f",
  greenSoft: "#e7f6ee",
  red: "#d22b2b",
  redSoft: "#fdeaea",
  amber: "#b06f00",
  amberSoft: "#fdf3e2",
  gray: "#5c6b7a",
  graySoft: "#eef1f4",
  blue: "#1551b8",
  blueSoft: "#e8f0fe",
} as const;

export const ENF_FONT = "'Inter', system-ui, sans-serif";
export const ENF_MONO = "'JetBrains Mono', monospace";

// Map a stage tone to its badge color pair.
export function stageColors(stage: EnforcementStage): { fg: string; bg: string } {
  const tone = ENFORCEMENT_STAGE_META[stage]?.tone ?? "neutral";
  switch (tone) {
    case "active":
      return { fg: ENF.red, bg: ENF.redSoft };
    case "paid":
      return { fg: ENF.green, bg: ENF.greenSoft };
    case "review":
      return { fg: ENF.amber, bg: ENF.amberSoft };
    case "released":
      return { fg: ENF.blue, bg: ENF.blueSoft };
    case "info":
      return { fg: ENF.blue, bg: ENF.blueSoft };
    case "neutral":
    default:
      return { fg: ENF.gray, bg: ENF.graySoft };
  }
}

// Stage badge — uppercase, bold, color-coded by semantic tone.
export function StageBadge({
  stage,
  testid,
}: {
  stage: EnforcementStage;
  testid?: string;
}) {
  const { fg, bg } = stageColors(stage);
  const label = ENFORCEMENT_STAGE_META[stage]?.label ?? stage;
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.04em]"
      style={{ color: fg, background: bg }}
      data-testid={testid}
    >
      {label}
    </span>
  );
}

// Plate text — the field-critical element. 18–22px, bold, uppercase, spaced.
export function PlateText({
  plate,
  size = 20,
  testid,
}: {
  plate: string;
  size?: number;
  testid?: string;
}) {
  return (
    <span
      className="font-bold uppercase"
      style={{
        fontFamily: ENF_MONO,
        fontSize: size,
        letterSpacing: "0.08em",
        color: ENF.ink,
      }}
      data-testid={testid}
    >
      {plate}
    </span>
  );
}

export function EnforcerShell({
  userName,
  lotName,
  shiftLabel,
  onShift,
  hasUnread,
  active,
  onNavigate,
  onOpenScan,
  onOpenMenu,
  onOpenNotifications,
  children,
}: {
  userName: string;
  lotName: string;
  shiftLabel: string;
  onShift: boolean;
  hasUnread: boolean;
  active: EnforcerView;
  onNavigate: (view: EnforcerView) => void;
  onOpenScan: () => void;
  onOpenMenu: () => void;
  onOpenNotifications: () => void;
  children: ReactNode;
}) {
  // The bottom nav only highlights the five primary tabs; sub-views (case,
  // evidence, payment) fall back to their parent context.
  const navActive: EnforcerView =
    active === "case" || active === "evidence" || active === "payment"
      ? "queue"
      : active;
  return (
    <div
      className="flex min-h-screen flex-col"
      style={{ background: "#fff", color: ENF.ink, fontFamily: ENF_FONT }}
      data-testid="enforcer-shell"
    >
      {/* Header — dark navy gradient (matches attendant field mode) */}
      <header
        className="sticky top-0 z-10 px-4 pb-[18px] pt-4 text-white"
        style={{
          background: `linear-gradient(160deg, ${ENF.header}, ${ENF.header2})`,
        }}
        data-testid="enforcer-header"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-[9px]">
            <span
              className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[9px] bg-white"
              data-testid="enforcer-logo"
            >
              <img
                src={logoMark}
                alt="Millennialz Parking, LLC"
                className="h-full w-full object-contain p-0.5"
              />
            </span>
            <div className="leading-[1.15]">
              <div className="text-sm font-bold" data-testid="enforcer-user-name">
                {userName}
              </div>
              <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-white/60">
                Enforcer
                <span
                  className="rounded-full px-1.5 py-px text-[8.5px] font-bold tracking-[0.06em]"
                  style={{ background: "rgba(232,86,10,.9)", color: "#fff" }}
                  data-testid="enforcer-preview-tag"
                >
                  PREVIEW
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-[15px] text-white/90">
            <button
              type="button"
              className="relative flex"
              onClick={onOpenNotifications}
              aria-label="Notifications"
              data-testid="button-enforcer-notifications"
            >
              <Bell className="h-[21px] w-[21px]" />
              {hasUnread && (
                <span
                  className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full"
                  style={{
                    background: "#ff5b5b",
                    border: `1.5px solid ${ENF.header2}`,
                  }}
                  data-testid="enforcer-notification-dot"
                />
              )}
            </button>
            <button
              type="button"
              className="flex"
              onClick={onOpenMenu}
              aria-label="Menu"
              data-testid="button-enforcer-menu"
            >
              <Menu className="h-[21px] w-[21px]" />
            </button>
          </div>
        </div>

        {/* Shift / lot bar */}
        <div
          className="mt-[14px] flex items-center justify-between gap-2 rounded-[0.875rem] px-[13px] py-[11px]"
          style={{
            background: "rgba(255,255,255,.09)",
            border: "1px solid rgba(255,255,255,.13)",
          }}
          data-testid="enforcer-shift-bar"
        >
          <div className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold">
            <MapPin className="h-4 w-4 shrink-0 opacity-85" />
            <span className="truncate" data-testid="enforcer-shift-lot">
              {lotName}
            </span>
          </div>
          <div
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[11.5px] font-bold"
            style={{
              color: onShift ? "#5ee0a0" : "rgba(255,255,255,.6)",
              background: onShift
                ? "rgba(94,224,160,.13)"
                : "rgba(255,255,255,.08)",
            }}
            data-testid="enforcer-shift-status"
          >
            <span
              className="h-[7px] w-[7px] rounded-full"
              style={{
                background: onShift ? "#3fcf86" : "rgba(255,255,255,.4)",
                boxShadow: onShift ? "0 0 0 3px rgba(63,207,134,.25)" : "none",
              }}
            />
            {shiftLabel}
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1" data-testid="enforcer-body">
        {children}
      </main>

      {/* Bottom tab bar — Home / Lookup / [Scan] / Queue / History */}
      <nav
        className="sticky bottom-0 flex gap-0.5 px-1.5 pb-[11px] pt-2"
        style={{ background: "#fff", borderTop: `1px solid ${ENF.line}` }}
        data-testid="enforcer-tabbar"
      >
        <TabButton
          icon={<HomeIcon className="h-[22px] w-[22px]" />}
          label="Home"
          active={navActive === "home"}
          onClick={() => onNavigate("home")}
          testid="tab-enforcer-home"
        />
        <TabButton
          icon={<SearchIcon className="h-[22px] w-[22px]" />}
          label="Lookup"
          active={navActive === "lookup"}
          onClick={() => onNavigate("lookup")}
          testid="tab-enforcer-lookup"
        />
        {/* Center FAB — Scan plate */}
        <div className="flex flex-1 flex-col items-center">
          <button
            type="button"
            onClick={onOpenScan}
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{
              background: ENF.orange,
              marginTop: -24,
              boxShadow: "0 6px 16px rgba(232,86,10,.4)",
              border: "3px solid #fff",
            }}
            aria-label="Scan plate"
            data-testid="button-enforcer-scan"
          >
            <Camera className="h-[24px] w-[24px] text-white" strokeWidth={2.3} />
          </button>
          <span
            className="mt-[3px] text-[10px] font-semibold"
            style={{ color: ENF.ink3 }}
          >
            Scan
          </span>
        </div>
        <TabButton
          icon={<ListChecks className="h-[22px] w-[22px]" />}
          label="Queue"
          active={navActive === "queue"}
          onClick={() => onNavigate("queue")}
          testid="tab-enforcer-queue"
        />
        <TabButton
          icon={<Clock className="h-[22px] w-[22px]" />}
          label="History"
          active={navActive === "history"}
          onClick={() => onNavigate("history")}
          testid="tab-enforcer-history"
        />
      </nav>
    </div>
  );
}

function TabButton({
  icon,
  label,
  active,
  onClick,
  testid,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 flex-col items-center gap-[3px] py-1 text-[10px] font-semibold"
      style={{ color: active ? ENF.accent : ENF.ink3 }}
      data-testid={testid}
    >
      {icon}
      {label}
    </button>
  );
}
