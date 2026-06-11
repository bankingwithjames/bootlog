import type { ReactNode } from "react";
import {
  Bell,
  Menu,
  MapPin,
  Home as HomeIcon,
  List,
  Clock,
  Search as SearchIcon,
  Plus,
} from "lucide-react";
import logoMark from "@assets/logo-mark.png";

// Attendant Field Mode navigation. Only "home" is functional in Page 1;
// the remaining views are placeholders that Pages 2-5 fill in.
export type FieldView =
  | "home"
  | "inventory"
  | "shift"
  | "search"
  | "add"
  | "request";

// Signal Blue palette (LOCKED 2026-06-10). Kept local to Field Mode so the
// global theme tokens stay untouched and admin/enforcer chrome is unaffected.
export const FIELD = {
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
  ledOn: "#3fcf86",
  ledText: "#5ee0a0",
} as const;

export const FIELD_FONT = "'Inter', system-ui, sans-serif";
export const FIELD_MONO = "'JetBrains Mono', monospace";

type ShiftStub = {
  // STUB (Page 2 wires real shift state): clearly a placeholder for now.
  onShift: boolean;
  label: string; // e.g. "On shift · 3h 12m"
};

export function FieldShell({
  userName,
  lotName,
  shift,
  hasUnread,
  active,
  onNavigate,
  onOpenFab,
  onOpenMenu,
  onOpenNotifications,
  children,
}: {
  userName: string;
  lotName: string;
  shift: ShiftStub;
  hasUnread: boolean;
  active: FieldView;
  onNavigate: (view: FieldView) => void;
  onOpenFab: () => void;
  onOpenMenu: () => void;
  onOpenNotifications: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="flex min-h-screen flex-col"
      style={{ background: "#fff", color: FIELD.ink, fontFamily: FIELD_FONT }}
      data-testid="field-shell"
    >
      {/* Header — dark navy gradient */}
      <header
        className="sticky top-0 z-10 px-4 pb-[18px] pt-4 text-white"
        style={{
          background: `linear-gradient(160deg, ${FIELD.header}, ${FIELD.header2})`,
        }}
        data-testid="field-header"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-[9px]">
            {/* Company logo — the official Millennialz Parking mark on a white
                tile (matches the desktop header treatment in home.tsx). */}
            <span
              className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[9px] bg-white"
              data-testid="field-logo"
            >
              <img
                src={logoMark}
                alt="Millennialz Parking, LLC"
                className="h-full w-full object-contain p-0.5"
              />
            </span>
            <div className="leading-[1.15]">
              <div className="text-sm font-bold" data-testid="field-user-name">
                {userName}
              </div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-white/60">
                Attendant
              </div>
            </div>
          </div>
          <div className="flex items-center gap-[15px] text-white/90">
            <button
              type="button"
              className="relative flex"
              onClick={onOpenNotifications}
              aria-label="Notifications"
              data-testid="button-field-notifications"
            >
              <Bell className="h-[21px] w-[21px]" />
              {hasUnread && (
                <span
                  className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full"
                  style={{
                    background: "#ff5b5b",
                    border: `1.5px solid ${FIELD.header2}`,
                  }}
                  data-testid="field-notification-dot"
                />
              )}
            </button>
            <button
              type="button"
              className="flex"
              onClick={onOpenMenu}
              aria-label="Menu"
              data-testid="button-field-menu"
            >
              <Menu className="h-[21px] w-[21px]" />
            </button>
          </div>
        </div>

        {/* Shift bar — reflects real shift state (Page 2). Green LED when on a
            shift; neutral/dim when off shift. */}
        <div
          className="mt-[14px] flex items-center justify-between gap-2 rounded-[0.875rem] px-[13px] py-[11px]"
          style={{
            background: "rgba(255,255,255,.09)",
            border: "1px solid rgba(255,255,255,.13)",
          }}
          data-testid="field-shift-bar"
        >
          <div className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold">
            <MapPin className="h-4 w-4 shrink-0 opacity-85" />
            <span className="truncate" data-testid="field-shift-lot">
              {lotName}
            </span>
          </div>
          <div
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[11.5px] font-bold"
            style={{
              color: shift.onShift ? FIELD.ledText : "rgba(255,255,255,.6)",
              background: shift.onShift
                ? "rgba(94,224,160,.13)"
                : "rgba(255,255,255,.08)",
            }}
            data-testid="field-shift-status"
          >
            <span
              className="h-[7px] w-[7px] rounded-full"
              style={{
                background: shift.onShift ? FIELD.ledOn : "rgba(255,255,255,.4)",
                boxShadow: shift.onShift
                  ? "0 0 0 3px rgba(63,207,134,.25)"
                  : "none",
              }}
            />
            {shift.label}
          </div>
        </div>
      </header>

      {/* Body slot */}
      <main className="flex-1" data-testid="field-body">
        {children}
      </main>

      {/* Bottom tab bar — sticky, with raised orange FAB */}
      <nav
        className="sticky bottom-0 flex gap-0.5 px-1.5 pb-[11px] pt-2"
        style={{ background: "#fff", borderTop: `1px solid ${FIELD.line}` }}
        data-testid="field-tabbar"
      >
        <TabButton
          icon={<HomeIcon className="h-[22px] w-[22px]" />}
          label="Home"
          active={active === "home"}
          onClick={() => onNavigate("home")}
          testid="tab-field-home"
        />
        <TabButton
          icon={<List className="h-[22px] w-[22px]" />}
          label="Inventory"
          active={active === "inventory"}
          onClick={() => onNavigate("inventory")}
          testid="tab-field-inventory"
        />
        {/* Center FAB */}
        <div className="flex flex-1 flex-col items-center">
          <button
            type="button"
            onClick={onOpenFab}
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{
              background: FIELD.orange,
              marginTop: -24,
              boxShadow: "0 6px 16px rgba(232,86,10,.4)",
              border: "3px solid #fff",
            }}
            aria-label="Quick actions"
            data-testid="button-field-fab"
          >
            <Plus className="h-[25px] w-[25px] text-white" strokeWidth={2.5} />
          </button>
        </div>
        <TabButton
          icon={<Clock className="h-[22px] w-[22px]" />}
          label="Shift"
          active={active === "shift"}
          onClick={() => onNavigate("shift")}
          testid="tab-field-shift"
        />
        <TabButton
          icon={<SearchIcon className="h-[22px] w-[22px]" />}
          label="Search"
          active={active === "search"}
          onClick={() => onNavigate("search")}
          testid="tab-field-search"
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
      style={{ color: active ? FIELD.accent : FIELD.ink3 }}
      data-testid={testid}
    >
      {icon}
      {label}
    </button>
  );
}
