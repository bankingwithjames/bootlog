import { useMemo, useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format, parseISO } from "date-fns";
import logoMark from "@assets/logo-mark.png";
import {
  Car,
  Plus,
  Trash2,
  Camera,
  X,
  ImagePlus,
  Moon,
  Sun,
  ParkingMeter,
  DollarSign,
  CreditCard,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  History as HistoryIcon,
  ChevronRight,
  LayoutDashboard,
  Gavel,
  Lock,
  Unlock,
  Handshake,
  RotateCcw,
  Clock,
  LogOut,
  Users as UsersIcon,
  Inbox,
  Send,
  ShieldCheck,
  UserPlus,
  Pencil,
  Check,
  Ban,
  EyeOff,
} from "lucide-react";

import {
  insertBootSchema,
  insertBootRequestSchema,
  createUserSchema,
  MAX_BOOT_PHOTOS,
  ROLES,
  ROLE_LABELS,
  type Boot,
  type BootStatus,
  type BootRequest,
  type User,
  type Role,
  type InsertBootRequest,
  type CreateUserInput,
} from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useTheme } from "@/components/theme-provider";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

// ---------- helpers ----------
type PaidCar = {
  id: string;
  makeModel: string;
  color: string;
  licensePlate: string;
  paidAt: string;
  source?: "stripe" | "manual";
};

function nowLocalInput(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

// Match Stripe plates to booted plates: uppercase, strip non-alphanumerics.
function normalizePlate(plate: string): string {
  return (plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function currency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Read an image File, downscale it (longest edge <= maxEdge) and re-encode as
// a JPEG data URL. Keeps base64 payloads small enough to store inline in
// SQLite while preserving enough detail for evidence photos. Runs entirely in
// the browser — no upload server needed.
async function fileToCompressedDataUrl(
  file: File,
  maxEdge = 1280,
  quality = 0.7,
): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });

  // Non-image or SVG: just return the original data URL.
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    return dataUrl;
  }

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not load image"));
    i.src = dataUrl;
  });

  let { width, height } = img;
  if (Math.max(width, height) > maxEdge) {
    const scale = maxEdge / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

const formSchema = insertBootSchema.extend({
  licensePlate: z.string().trim().min(1, "License plate is required"),
  makeModel: z.string().trim().min(1, "Make & model is required"),
  bootedAt: z.string().min(1, "Date & time is required"),
  bootFee: z.coerce.number().min(0, "Fee can't be negative"),
});
type FormValues = z.infer<typeof formSchema>;

// ---------- enforcement status helpers ----------
type StatusMeta = {
  label: string;
  // Tailwind classes for the status badge.
  badge: string;
  icon: typeof Lock;
  // Short description shown in the queue / tooltips.
  blurb: string;
};

const STATUS_META: Record<BootStatus, StatusMeta> = {
  booted: {
    label: "Booted",
    badge:
      "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
    icon: Lock,
    blurb: "On boot — awaiting resolution",
  },
  released: {
    label: "Released",
    badge:
      "border-transparent bg-slate-500/15 text-slate-700 dark:text-slate-300",
    icon: Unlock,
    blurb: "Released for no fee",
  },
  settled: {
    label: "Settled",
    badge:
      "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400",
    icon: Handshake,
    blurb: "Settled for a partial amount",
  },
  completed: {
    label: "Completed",
    badge:
      "border-transparent bg-primary/15 text-primary hover:bg-primary/15",
    icon: CheckCircle2,
    blurb: "Paid in full",
  },
};

function StatusBadge({ status, testid }: { status: BootStatus; testid?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.booted;
  const Icon = meta.icon;
  return (
    <Badge className={`gap-1 ${meta.badge}`} data-testid={testid}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

// Manual paid-car entry (attendant-added, merged with Stripe data).
const manualSchema = z.object({
  licensePlate: z.string().trim().min(1, "License plate is required"),
  makeModel: z.string().trim().min(1, "Make & model is required"),
  color: z.string().trim().min(1, "Color is required"),
});
type ManualValues = z.infer<typeof manualSchema>;

const TZ_OFFSET = new Date().getTimezoneOffset(); // minutes

function Logo() {
  return (
    <div className="flex items-center gap-2.5" data-testid="logo-header">
      <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-border">
        <img
          src={logoMark}
          alt="Millennialz Parking, LLC"
          className="h-full w-full object-contain p-0.5"
        />
      </span>
      <div className="leading-tight">
        <span className="block text-base font-bold tracking-tight">BootLog - Daily Vehicle Inventory</span>
        <span className="block text-xs text-muted-foreground">
          Millennialz Parking, LLC
        </span>
      </div>
    </div>
  );
}

export default function Home() {
  const { theme, toggle } = useTheme();
  const { toast } = useToast();
  const { user, logout, can, isAttendant, isAdmin } = useAuth();

  // App settings (admin-controlled). historyVisibleDays = how many days BACK
  // staff may view within the 30-day window; admin always sees all 30.
  // showFinancialsToStaff gates whether staff see the financial summary cards.
  const { data: settings } = useQuery<{
    historyVisibleDays: number;
    showFinancialsToStaff: boolean;
  }>({
    queryKey: ["/api/settings"],
  });
  const historyVisibleDays = settings?.historyVisibleDays ?? 1;
  const showFinancialsToStaff = settings?.showFinancialsToStaff ?? false;
  // Admins always see the financial cards. Staff only when an admin opts in.
  const canSeeFinancials = isAdmin || showFinancialsToStaff;
  // Admins are never limited. Staff are limited to `historyVisibleDays` back.
  const visibleDaysBack = isAdmin ? 29 : historyVisibleDays;

  const todayStr = format(new Date(), "yyyy-MM-dd");
  // Earliest browsable day. Admin: full rolling 30-day window. Staff: limited
  // to the configured visibility window so older payment history stays private.
  const minDateStr = format(
    new Date(Date.now() - visibleDaysBack * 86400000),
    "yyyy-MM-dd",
  );
  const [filterDate, setFilterDate] = useState<string>(todayStr);

  // If the visibility window tightens (or we're staff) and the currently
  // selected date falls outside it, snap back to a visible date.
  useEffect(() => {
    if (filterDate < minDateStr) setFilterDate(todayStr);
  }, [minDateStr, filterDate, todayStr]);

  const { data: boots = [], isLoading } = useQuery<Boot[]>({
    queryKey: ["/api/boots", TZ_OFFSET],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/boots?tz=${TZ_OFFSET}`);
      return res.json();
    },
  });

  // Paid cars for the selected date. Today reads live from Stripe; past days
  // come from the stored 30-day snapshot. `source` tells us which.
  const {
    data: paidData,
    isLoading: paidLoading,
    isError: paidError,
    error: paidErrObj,
    refetch: refetchPaid,
    isFetching: paidFetching,
  } = useQuery<{ cars: PaidCar[]; source: "live" | "stored" }>({
    queryKey: ["/api/paid-cars", filterDate, TZ_OFFSET],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/paid-cars?date=${filterDate}&tz=${TZ_OFFSET}`,
      );
      return res.json();
    },
  });
  const paidCars = paidData?.cars ?? [];
  const paidSource = paidData?.source ?? "live";

  // 30-day history (per-day boot / paid / enforcement counts).
  const {
    data: historyData,
    isLoading: historyLoading,
    refetch: refetchHistory,
    isFetching: historyFetching,
  } = useQuery<{ days: HistoryDay[] }>({
    queryKey: ["/api/history", TZ_OFFSET],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/history?tz=${TZ_OFFSET}`);
      return res.json();
    },
  });
  const historyDays = historyData?.days ?? [];

  // Top-level view: day detail, the enforcement queue, the 30-day history,
  // the boot-request queue, or (admin only) user management.
  type View = "day" | "enforcement" | "history" | "requests" | "users";
  const [view, setView] = useState<View>(
    isAttendant ? "day" : "day",
  );

  // Boot requests (attendant submits, enforcer/admin works). Everyone signed in
  // can read; the server scopes attendants to their own requests.
  const { data: requests = [], isLoading: requestsLoading } = useQuery<
    BootRequest[]
  >({ queryKey: ["/api/boot-requests"] });
  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === "pending"),
    [requests],
  );

  // Users (admin only). Skip the request entirely for non-admins.
  const { data: users = [], isLoading: usersLoading } = useQuery<User[]>({
    queryKey: ["/api/users"],
    enabled: can.manageUsers,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      licensePlate: "",
      makeModel: "",
      bootedAt: nowLocalInput(),
      bootFee: 0,
      photos: [],
    },
  });

  // Lightbox: the full-size photo currently being viewed (or null).
  const [lightbox, setLightbox] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = {
        ...values,
        bootedAt: new Date(values.bootedAt).toISOString(),
      };
      const res = await apiRequest("POST", "/api/boots", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/boots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      form.reset({
        licensePlate: "",
        makeModel: "",
        bootedAt: nowLocalInput(),
        bootFee: 0,
        photos: [],
      });
      toast({
        title: "Boot placed",
        description: "Vehicle is now on boot, awaiting resolution.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not log boot",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Advance a boot through the enforcement lifecycle.
  const statusMutation = useMutation({
    mutationFn: async (vars: {
      id: number;
      status: BootStatus;
      amountCollected?: number;
    }) => {
      const res = await apiRequest("PATCH", `/api/boots/${vars.id}`, {
        status: vars.status,
        amountCollected: vars.amountCollected,
      });
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/boots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      toast({
        title: "Status updated",
        description: `Boot marked ${STATUS_META[vars.status].label}.`,
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not update status",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Settle dialog state (capturing a partial collected amount).
  const [settleBoot, setSettleBoot] = useState<Boot | null>(null);
  const [settleAmount, setSettleAmount] = useState<string>("");

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/boots/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/boots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      toast({ title: "Removed", description: "Boot record deleted." });
    },
  });

  // Manual paid-car entry: form + mutation. Adds a paid car to the selected
  // day, merged with Stripe data and persisted into the 30-day snapshot.
  const [showManual, setShowManual] = useState(false);
  const manualForm = useForm<ManualValues>({
    resolver: zodResolver(manualSchema),
    defaultValues: { licensePlate: "", makeModel: "", color: "" },
  });

  const manualMutation = useMutation({
    mutationFn: async (values: ManualValues) => {
      const res = await apiRequest("POST", "/api/paid-cars/manual", {
        ...values,
        date: filterDate,
        tz: TZ_OFFSET,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/paid-cars"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      manualForm.reset({ licensePlate: "", makeModel: "", color: "" });
      setShowManual(false);
      toast({
        title: "Paid car added",
        description: "Manually logged into this day's paid list.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not add paid car",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Attendant submits a boot request into the pending queue.
  const requestMutation = useMutation({
    mutationFn: async (values: InsertBootRequest) => {
      const res = await apiRequest("POST", "/api/boot-requests", values);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/boot-requests"] });
      toast({
        title: "Request submitted",
        description: "An enforcer will review and initiate the boot.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not submit request",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Enforcer/admin resolves a request: initiate (creates a real boot) or dismiss.
  const resolveRequestMutation = useMutation({
    mutationFn: async (vars: {
      id: number;
      action: "initiate" | "dismiss";
      bootFee?: number;
    }) => {
      const res = await apiRequest("PATCH", `/api/boot-requests/${vars.id}`, {
        action: vars.action,
        bootFee: vars.bootFee,
      });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/boot-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/boots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      toast({
        title: vars.action === "initiate" ? "Boot initiated" : "Request dismissed",
        description:
          vars.action === "initiate"
            ? "The request is now an active boot in the enforcement queue."
            : "The request was closed without booting.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not resolve request",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Monthly stats (current calendar month, local).
  const now = new Date();
  const monthLabel = format(now, "MMMM yyyy");
  const monthly = useMemo(() => {
    let count = 0;
    let fees = 0;
    for (const b of boots) {
      const d = parseISO(b.bootedAt);
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
        count += 1;
        fees += b.amountCollected ?? 0;
      }
    }
    return { count, fees };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boots]);

  // Active enforcement queue: every boot still in the "booted" status,
  // newest first. This is the attendant's daily work list.
  const activeBoots = useMemo(
    () => boots.filter((b) => (b.status ?? "booted") === "booted"),
    [boots],
  );

  // Booted rows for the selected date.
  const filteredBoots = useMemo(
    () =>
      boots.filter(
        (b) => format(parseISO(b.bootedAt), "yyyy-MM-dd") === filterDate,
      ),
    [boots, filterDate],
  );

  // Set of paid plates (normalized) for cross-reference.
  const paidPlateSet = useMemo(
    () => new Set(paidCars.map((p) => normalizePlate(p.licensePlate)).filter(Boolean)),
    [paidCars],
  );

  const dayCount = filteredBoots.length;
  const dayFees = filteredBoots.reduce(
    (s, b) => s + (b.amountCollected ?? 0),
    0,
  );
  const filterLabel =
    filterDate === todayStr
      ? "Today"
      : format(parseISO(filterDate + "T00:00:00"), "EEE, MMM d, yyyy");

  // Enforcement candidates: booted but NOT found in Stripe paid list.
  const unpaidBooted = useMemo(
    () =>
      filteredBoots.filter(
        (b) => !paidPlateSet.has(normalizePlate(b.licensePlate)),
      ),
    [filteredBoots, paidPlateSet],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Logo />
          <div className="flex items-center gap-2">
            {user && (
              <div
                className="hidden items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm sm:flex"
                data-testid="badge-current-user"
              >
                <span className="font-medium" data-testid="text-current-user-name">
                  {user.name}
                </span>
                <Badge
                  variant="secondary"
                  className="gap-1"
                  data-testid="text-current-user-role"
                >
                  <ShieldCheck className="h-3 w-3" />
                  {ROLE_LABELS[user.role as Role]}
                </Badge>
              </div>
            )}
            <Button
              variant="outline"
              size="icon"
              onClick={toggle}
              aria-label="Toggle dark mode"
              data-testid="button-theme-toggle"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => logout()}
              data-testid="button-logout"
            >
              <LogOut className="mr-1.5 h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <section className="mb-6">
          <h1 className="mb-1 text-xl font-bold tracking-tight">
            Attendant Dashboard
          </h1>
          <p className="mb-4 text-sm text-muted-foreground">
            Place boots, work the enforcement queue, and collect on violations for {monthLabel}.
          </p>
          <div
            className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
              canSeeFinancials ? "lg:grid-cols-4" : "sm:grid-cols-1"
            }`}
          >
            <StatCard
              icon={<Gavel className="h-5 w-5" />}
              label="Active enforcement"
              value={isLoading ? null : String(activeBoots.length)}
              testid="stat-active-enforcement"
              accent={activeBoots.length > 0}
            />
            {/* Financial summary cards — hidden from staff unless an admin
                has enabled "Show financial summary to staff". Admin always
                sees these. Keeps revenue/payment counts confidential. */}
            {canSeeFinancials && (
              <>
                <StatCard
                  icon={<ParkingMeter className="h-5 w-5" />}
                  label={`Cars booted · ${monthLabel}`}
                  value={isLoading ? null : String(monthly.count)}
                  testid="stat-month-count"
                />
                <StatCard
                  icon={<DollarSign className="h-5 w-5" />}
                  label={`Collected · ${monthLabel}`}
                  value={isLoading ? null : currency(monthly.fees)}
                  testid="stat-month-fees"
                />
                <StatCard
                  icon={<CreditCard className="h-5 w-5" />}
                  label={`Paid via Stripe · ${filterLabel}`}
                  value={paidLoading ? null : paidError ? "—" : String(paidCars.length)}
                  testid="stat-paid-count"
                />
              </>
            )}
          </div>
        </section>

        {/* View toggle: daily detail vs. 30-day history */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-md border p-0.5">
            <Button
              variant={view === "day" ? "default" : "ghost"}
              size="sm"
              className="h-8"
              onClick={() => setView("day")}
              data-testid="button-view-day"
            >
              <LayoutDashboard className="mr-1.5 h-4 w-4" />
              Daily View
            </Button>
            {can.enforcement && (
              <Button
                variant={view === "enforcement" ? "default" : "ghost"}
                size="sm"
                className="h-8"
                onClick={() => setView("enforcement")}
                data-testid="button-view-enforcement"
              >
                <Gavel className="mr-1.5 h-4 w-4" />
                Enforcement
                {activeBoots.length > 0 && (
                  <span
                    className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400"
                    data-testid="badge-active-count"
                  >
                    {activeBoots.length}
                  </span>
                )}
              </Button>
            )}
            <Button
              variant={view === "requests" ? "default" : "ghost"}
              size="sm"
              className="h-8"
              onClick={() => setView("requests")}
              data-testid="button-view-requests"
            >
              <Inbox className="mr-1.5 h-4 w-4" />
              {isAttendant ? "My Requests" : "Requests"}
              {pendingRequests.length > 0 && (
                <span
                  className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400"
                  data-testid="badge-pending-count"
                >
                  {pendingRequests.length}
                </span>
              )}
            </Button>
            <Button
              variant={view === "history" ? "default" : "ghost"}
              size="sm"
              className="h-8"
              onClick={() => setView("history")}
              data-testid="button-view-history"
            >
              <HistoryIcon className="mr-1.5 h-4 w-4" />
              30-Day History
            </Button>
            {can.manageUsers && (
              <Button
                variant={view === "users" ? "default" : "ghost"}
                size="sm"
                className="h-8"
                onClick={() => setView("users")}
                data-testid="button-view-users"
              >
                <UsersIcon className="mr-1.5 h-4 w-4" />
                Users
              </Button>
            )}
          </div>

          {view === "day" && (
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="filter-date" className="text-sm font-medium">
                Viewing date
              </Label>
              <Input
                id="filter-date"
                type="date"
                value={filterDate}
                min={minDateStr}
                max={todayStr}
                onChange={(e) => setFilterDate(e.target.value)}
                className="w-auto"
                data-testid="input-filter-date"
              />
              {filterDate !== todayStr && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFilterDate(todayStr)}
                  data-testid="button-today"
                >
                  Today
                </Button>
              )}
            </div>
          )}
        </div>

        {view === "users" && can.manageUsers ? (
          <div className="space-y-4">
            <SettingsCard
              historyVisibleDays={historyVisibleDays}
              showFinancialsToStaff={showFinancialsToStaff}
            />
            <UsersView users={users} loading={usersLoading} currentUserId={user?.id} />
          </div>
        ) : view === "requests" ? (

          <RequestsView
            requests={requests}
            loading={requestsLoading}
            canWork={can.workRequests}
            canRequest={can.requestBoot}
            isPending={resolveRequestMutation.isPending}
            submitPending={requestMutation.isPending}
            onSubmit={(v) => requestMutation.mutate(v)}
            onResolve={(id, action, bootFee) =>
              resolveRequestMutation.mutate({ id, action, bootFee })
            }
            onView={(src) => setLightbox(src)}
          />
        ) : view === "history" ? (
          <HistoryView
            days={historyDays}
            loading={historyLoading}
            fetching={historyFetching}
            onRefresh={() => refetchHistory()}
            onOpenDay={(d) => {
              setFilterDate(d);
              setView("day");
            }}
          />
        ) : view === "enforcement" && can.enforcement ? (
          <EnforcementView
            boots={boots}
            loading={isLoading}
            isPending={statusMutation.isPending}
            onSetStatus={(id, status, amountCollected) =>
              statusMutation.mutate({ id, status, amountCollected })
            }
            onOpenSettle={(b) => {
              setSettleBoot(b);
              setSettleAmount("");
            }}
            onView={(src) => setLightbox(src)}
          />
        ) : (

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
          {/* Add form (only enforcers/admins place boots directly) */}
          {can.placeBoot ? (
          <Card className="h-fit lg:sticky lg:top-20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plus className="h-4 w-4 text-primary" />
                Place a Boot
              </CardTitle>
              <CardDescription>
                Enter the vehicle and the boot fee owed. It enters the
                enforcement queue as <strong>Booted</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit((v) => createMutation.mutate(v))}
                  className="space-y-4"
                >
                  <FormField
                    control={form.control}
                    name="licensePlate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>License Plate</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="ABC-1234"
                            autoComplete="off"
                            className="uppercase"
                            data-testid="input-plate"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="makeModel"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Make &amp; Model</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Honda Civic"
                            autoComplete="off"
                            data-testid="input-makemodel"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="bootedAt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Date &amp; Time</FormLabel>
                        <FormControl>
                          <Input type="datetime-local" data-testid="input-datetime" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="bootFee"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Boot Fee Owed ($)</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                              $
                            </span>
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="0.00"
                              className="pl-7"
                              data-testid="input-fee"
                              {...field}
                            />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="photos"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Evidence Photos{" "}
                          <span className="font-normal text-muted-foreground">
                            (up to {MAX_BOOT_PHOTOS})
                          </span>
                        </FormLabel>
                        <FormControl>
                          <PhotoUploadField
                            value={field.value ?? []}
                            onChange={field.onChange}
                            onView={(src) => setLightbox(src)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={createMutation.isPending}
                    data-testid="button-submit"
                  >
                    {createMutation.isPending ? "Saving…" : "Place Boot"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
          ) : (
          <Card className="h-fit lg:sticky lg:top-20" data-testid="card-request-prompt">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Send className="h-4 w-4 text-primary" />
                Request a Boot
              </CardTitle>
              <CardDescription>
                As an attendant you can flag a vehicle for booting. An enforcer
                reviews your request and initiates the boot.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                className="w-full"
                onClick={() => setView("requests")}
                data-testid="button-goto-request"
              >
                <Send className="mr-1.5 h-4 w-4" />
                Go to boot requests
              </Button>
            </CardContent>
          </Card>
          )}

          {/* Tabbed tables */}
          <Card>
            <Tabs defaultValue="booted" className="w-full">
              <CardHeader className="gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <TabsList>
                    <TabsTrigger value="booted" data-testid="tab-booted">
                      <Car className="mr-1.5 h-4 w-4" />
                      Booted ({filteredBoots.length})
                    </TabsTrigger>
                    <TabsTrigger value="paid" data-testid="tab-paid">
                      <CreditCard className="mr-1.5 h-4 w-4" />
                      Paid Cars ({paidLoading ? "…" : paidCars.length})
                    </TabsTrigger>
                  </TabsList>
                  <span className="text-sm text-muted-foreground">{filterLabel}</span>
                </div>
              </CardHeader>

              <CardContent>
                {/* BOOTED TAB */}
                <TabsContent value="booted" className="mt-0">
                  {!paidLoading && !paidError && filteredBoots.length > 0 && (
                    <div
                      className={`mb-4 flex items-start gap-2 rounded-md border p-3 text-sm ${
                        unpaidBooted.length > 0
                          ? "border-destructive/40 bg-destructive/5"
                          : "border-border bg-muted/40"
                      }`}
                      data-testid="banner-enforcement"
                    >
                      {unpaidBooted.length > 0 ? (
                        <>
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                          <span>
                            <strong>{unpaidBooted.length}</strong> booted vehicle
                            {unpaidBooted.length === 1 ? " has" : "s have"} no matching
                            Stripe payment — enforcement charge candidate
                            {unpaidBooted.length === 1 ? "" : "s"}.
                          </span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          <span>All booted vehicles have a matching Stripe payment.</span>
                        </>
                      )}
                    </div>
                  )}

                  {isLoading ? (
                    <TableSkeleton />
                  ) : filteredBoots.length === 0 ? (
                    <EmptyState
                      icon={<ParkingMeter className="h-8 w-8 text-muted-foreground/50" />}
                      title={`No boots logged for ${filterLabel}`}
                      subtitle="Add a vehicle using the form, or pick a different date."
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>License Plate</TableHead>
                            <TableHead>Make &amp; Model</TableHead>
                            <TableHead className="whitespace-nowrap">Time</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Payment</TableHead>
                            <TableHead>Photos</TableHead>
                            <TableHead className="text-right whitespace-nowrap">Fee / Collected</TableHead>
                            <TableHead className="w-10" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredBoots.map((b) => {
                            const matched = paidPlateSet.has(normalizePlate(b.licensePlate));
                            const status = (b.status ?? "booted") as BootStatus;
                            return (
                              <TableRow key={b.id} data-testid={`row-boot-${b.id}`}>
                                <TableCell className="font-mono font-semibold uppercase">
                                  {b.licensePlate}
                                </TableCell>
                                <TableCell>
                                  {b.makeModel}
                                  {b.createdByName && (
                                    <span
                                      className="block text-xs text-muted-foreground"
                                      data-testid={`text-created-by-${b.id}`}
                                    >
                                      by {b.createdByName}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="whitespace-nowrap text-muted-foreground">
                                  {format(parseISO(b.bootedAt), "h:mm a")}
                                </TableCell>
                                <TableCell>
                                  <StatusBadge
                                    status={status}
                                    testid={`enforce-status-${b.id}`}
                                  />
                                </TableCell>
                                <TableCell>
                                  {paidLoading ? (
                                    <Skeleton className="h-5 w-16" />
                                  ) : paidError ? (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  ) : matched ? (
                                    <Badge
                                      className="gap-1 border-transparent bg-primary/15 text-primary hover:bg-primary/15"
                                      data-testid={`status-${b.id}`}
                                    >
                                      <CheckCircle2 className="h-3 w-3" />
                                      Paid
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="destructive"
                                      className="gap-1"
                                      data-testid={`status-${b.id}`}
                                    >
                                      <AlertTriangle className="h-3 w-3" />
                                      Not Paid
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <PhotoThumbs
                                    photos={b.photos ?? []}
                                    bootId={b.id}
                                    onView={(src) => setLightbox(src)}
                                  />
                                </TableCell>
                                <TableCell className="text-right tabular-nums whitespace-nowrap">
                                  <span className="text-muted-foreground">
                                    {currency(b.bootFee ?? 0)}
                                  </span>
                                  {(b.amountCollected ?? 0) > 0 && (
                                    <span className="font-semibold text-foreground">
                                      {" "}
                                      / {currency(b.amountCollected)}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {can.deleteBoot && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                      onClick={() => deleteMutation.mutate(b.id)}
                                      aria-label="Delete record"
                                      data-testid={`button-delete-${b.id}`}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                      <div className="mt-3 flex flex-wrap justify-end gap-x-6 border-t pt-3 text-sm">
                        <span>
                          <span className="text-muted-foreground">
                            Collected ({filterLabel}):&nbsp;
                          </span>
                          <span
                            className="font-semibold tabular-nums"
                            data-testid="text-day-total"
                          >
                            {currency(dayFees)}
                          </span>
                        </span>
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* PAID CARS TAB */}
                <TabsContent value="paid" className="mt-0">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      {paidSource === "stored" ? (
                        <Badge
                          variant="secondary"
                          className="gap-1"
                          data-testid="badge-paid-source"
                        >
                          <HistoryIcon className="h-3 w-3" />
                          Stored snapshot
                        </Badge>
                      ) : (
                        <Badge
                          className="gap-1 border-transparent bg-primary/15 text-primary hover:bg-primary/15"
                          data-testid="badge-paid-source"
                        >
                          <RefreshCw className="h-3 w-3" />
                          Live from Stripe
                        </Badge>
                      )}
                      <span>Payment amount intentionally hidden.</span>
                    </p>
                    <div className="flex items-center gap-2">
                      {/* Manual transaction entry is a financial action,
                          limited to enforcers and admins (3rd-party payments
                          are recorded here and auto-mark the matching boot
                          as Paid). Attendants do not see this control. */}
                      {can.logPaidCar && (
                        <Button
                          variant={showManual ? "secondary" : "default"}
                          size="sm"
                          onClick={() => setShowManual((s) => !s)}
                          data-testid="button-toggle-manual"
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add paid car
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => refetchPaid()}
                        disabled={paidFetching}
                        data-testid="button-refresh-paid"
                      >
                        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${paidFetching ? "animate-spin" : ""}`} />
                        Refresh
                      </Button>
                    </div>
                  </div>

                  {/* Manual paid-car entry form (collapsible) */}
                  {showManual && can.logPaidCar && (
                    <div
                      className="mb-4 rounded-md border bg-muted/30 p-4"
                      data-testid="form-manual"
                    >
                      <p className="mb-3 text-sm font-medium">
                        Add a paid car for {filterLabel}
                      </p>
                      <Form {...manualForm}>
                        <form
                          onSubmit={manualForm.handleSubmit((v) =>
                            manualMutation.mutate(v),
                          )}
                          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
                        >
                          <FormField
                            control={manualForm.control}
                            name="licensePlate"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>License Plate</FormLabel>
                                <FormControl>
                                  <Input
                                    placeholder="ABC-1234"
                                    autoComplete="off"
                                    className="uppercase"
                                    data-testid="input-manual-plate"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={manualForm.control}
                            name="makeModel"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Make &amp; Model</FormLabel>
                                <FormControl>
                                  <Input
                                    placeholder="Honda Civic"
                                    autoComplete="off"
                                    data-testid="input-manual-makemodel"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={manualForm.control}
                            name="color"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Color</FormLabel>
                                <FormControl>
                                  <Input
                                    placeholder="White"
                                    autoComplete="off"
                                    data-testid="input-manual-color"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <div className="flex items-center gap-2 sm:col-span-3">
                            <Button
                              type="submit"
                              size="sm"
                              disabled={manualMutation.isPending}
                              data-testid="button-manual-submit"
                            >
                              {manualMutation.isPending ? "Adding…" : "Add paid car"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                manualForm.reset({
                                  licensePlate: "",
                                  makeModel: "",
                                  color: "",
                                });
                                setShowManual(false);
                              }}
                              data-testid="button-manual-cancel"
                            >
                              Cancel
                            </Button>
                          </div>
                        </form>
                      </Form>
                    </div>
                  )}

                  {paidLoading ? (
                    <TableSkeleton />
                  ) : paidError ? (
                    <div
                      className="flex flex-col items-center justify-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 py-12 text-center"
                      data-testid="paid-error"
                    >
                      <AlertTriangle className="h-7 w-7 text-destructive" />
                      <p className="text-sm font-medium">Couldn’t reach Stripe</p>
                      <p className="max-w-md text-xs text-muted-foreground">
                        {(paidErrObj as Error)?.message ||
                          "The Stripe key may be unavailable in this environment."}
                      </p>
                    </div>
                  ) : paidCars.length === 0 ? (
                    <EmptyState
                      icon={<CreditCard className="h-8 w-8 text-muted-foreground/50" />}
                      title={`No Stripe payments for ${filterLabel}`}
                      subtitle="Pick a different date to see paid vehicles."
                    />
                  ) : (
                    <>
                      {/* Mobile: stacked cards — all info visible, no horizontal scroll */}
                      <div className="space-y-3 sm:hidden">
                        {paidCars.map((c) => {
                          const sourceBadge =
                            c.source === "manual" ? (
                              <Badge
                                variant="secondary"
                                className="gap-1"
                                data-testid={`badge-source-${c.id}`}
                              >
                                <Plus className="h-3 w-3" />
                                Manual
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="gap-1 text-muted-foreground"
                                data-testid={`badge-source-${c.id}`}
                              >
                                <CreditCard className="h-3 w-3" />
                                Stripe
                              </Badge>
                            );
                          return (
                            <div
                              key={c.id}
                              className="rounded-md border bg-card p-3"
                              data-testid={`row-paid-${c.id}`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-base font-semibold uppercase">
                                  {c.licensePlate || "—"}
                                </span>
                                {sourceBadge}
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                                <span>
                                  <span className="text-foreground">
                                    {c.makeModel || "—"}
                                  </span>
                                  {c.color ? ` · ${c.color}` : ""}
                                </span>
                                <span className="ml-auto whitespace-nowrap">
                                  {format(parseISO(c.paidAt), "h:mm a")}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {/* Desktop: full table */}
                      <div className="hidden sm:block">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>License Plate</TableHead>
                              <TableHead>Make / Model</TableHead>
                              <TableHead>Color</TableHead>
                              <TableHead>Source</TableHead>
                              <TableHead className="whitespace-nowrap">Time</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {paidCars.map((c) => (
                              <TableRow key={c.id} data-testid={`row-paid-desktop-${c.id}`}>
                                <TableCell className="font-mono font-semibold uppercase">
                                  {c.licensePlate || "—"}
                                </TableCell>
                                <TableCell>{c.makeModel || "—"}</TableCell>
                                <TableCell>{c.color || "—"}</TableCell>
                                <TableCell>
                                  {c.source === "manual" ? (
                                    <Badge
                                      variant="secondary"
                                      className="gap-1"
                                    >
                                      <Plus className="h-3 w-3" />
                                      Manual
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="gap-1 text-muted-foreground"
                                    >
                                      <CreditCard className="h-3 w-3" />
                                      Stripe
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell className="whitespace-nowrap text-muted-foreground">
                                  {format(parseISO(c.paidAt), "h:mm a")}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  )}
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>
        </div>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Boots move through Booted → Released / Settled / Completed. Paid-car
          data is read live from your Stripe account and stored for 30 days.
        </p>
      </main>

      {/* Settle-for-less dialog: capture the partial amount collected. */}
      <Dialog
        open={settleBoot !== null}
        onOpenChange={(open) => {
          if (!open) setSettleBoot(null);
        }}
      >
        <DialogContent data-testid="dialog-settle">
          <DialogHeader>
            <DialogTitle>Settle for less</DialogTitle>
            <DialogDescription>
              {settleBoot && (
                <>
                  Record the amount accepted to release{" "}
                  <span className="font-mono font-semibold uppercase">
                    {settleBoot.licensePlate}
                  </span>
                  . Full boot fee owed is{" "}
                  <strong>{currency(settleBoot.bootFee ?? 0)}</strong>.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="settle-amount">Amount collected ($)</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <Input
                id="settle-amount"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                className="pl-7"
                value={settleAmount}
                onChange={(e) => setSettleAmount(e.target.value)}
                data-testid="input-settle-amount"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setSettleBoot(null)}
              data-testid="button-settle-cancel"
            >
              Cancel
            </Button>
            <Button
              disabled={
                statusMutation.isPending ||
                !(parseFloat(settleAmount) > 0)
              }
              onClick={() => {
                if (!settleBoot) return;
                const amt = parseFloat(settleAmount);
                if (!(amt > 0)) return;
                statusMutation.mutate(
                  {
                    id: settleBoot.id,
                    status: "settled",
                    amountCollected: amt,
                  },
                  { onSuccess: () => setSettleBoot(null) },
                );
              }}
              data-testid="button-settle-confirm"
            >
              {statusMutation.isPending ? "Saving…" : "Record settlement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Photo lightbox: view an evidence photo full-size. */}
      <Dialog
        open={lightbox !== null}
        onOpenChange={(open) => !open && setLightbox(null)}
      >
        <DialogContent
          className="max-w-3xl p-2 sm:p-3"
          data-testid="dialog-lightbox"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Evidence photo</DialogTitle>
            <DialogDescription>Full-size evidence photo</DialogDescription>
          </DialogHeader>
          {lightbox && (
            <img
              src={lightbox}
              alt="Evidence photo"
              className="max-h-[80vh] w-full rounded-md object-contain"
              data-testid="img-lightbox"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- evidence photos ----------
// Capture/upload up to MAX_BOOT_PHOTOS images on the Place a Boot form.
// Images are compressed client-side to JPEG data URLs. The hidden file input
// uses `capture` so phones can open the camera directly (or pick from library).
function PhotoUploadField({
  value,
  onChange,
  onView,
}: {
  value: string[];
  onChange: (photos: string[]) => void;
  onView: (src: string) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const remaining = MAX_BOOT_PHOTOS - value.length;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    let toAdd = picked;
    if (picked.length > remaining) {
      toAdd = picked.slice(0, remaining);
      toast({
        title: "Photo limit reached",
        description: `Only ${MAX_BOOT_PHOTOS} photos allowed. Added the first ${remaining}.`,
      });
    }
    setBusy(true);
    try {
      const encoded: string[] = [];
      for (const f of toAdd) {
        try {
          encoded.push(await fileToCompressedDataUrl(f));
        } catch {
          // Skip files that fail to process.
        }
      }
      if (encoded.length) onChange([...value, ...encoded]);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function removeAt(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        data-testid="input-photos"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="flex flex-wrap gap-2">
        {value.map((src, i) => (
          <div
            key={i}
            className="group relative h-16 w-16 overflow-hidden rounded-md border"
            data-testid={`thumb-form-${i}`}
          >
            <button
              type="button"
              className="h-full w-full"
              onClick={() => onView(src)}
              aria-label={`View photo ${i + 1}`}
            >
              <img
                src={src}
                alt={`Evidence ${i + 1}`}
                className="h-full w-full object-cover"
              />
            </button>
            <button
              type="button"
              onClick={() => removeAt(i)}
              className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-90 transition hover:bg-black/80"
              data-testid={`button-remove-photo-${i}`}
              aria-label={`Remove photo ${i + 1}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-50"
            data-testid="button-add-photo"
          >
            {busy ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <ImagePlus className="h-5 w-5" />
            )}
            <span className="text-[10px] leading-none">
              {busy ? "…" : "Add"}
            </span>
          </button>
        )}
      </div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Camera className="h-3 w-3" />
        {value.length}/{MAX_BOOT_PHOTOS} added — tap to use camera or library.
      </p>
    </div>
  );
}

// Read-only row of photo thumbnails for an existing boot. Click to enlarge.
function PhotoThumbs({
  photos,
  bootId,
  onView,
}: {
  photos: string[];
  bootId: number;
  onView: (src: string) => void;
}) {
  if (!photos || photos.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const shown = photos.slice(0, 3);
  const extra = photos.length - shown.length;
  return (
    <div className="flex items-center gap-1" data-testid={`photos-boot-${bootId}`}>
      {shown.map((src, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onView(src)}
          className="h-9 w-9 overflow-hidden rounded border transition hover:ring-2 hover:ring-primary"
          data-testid={`thumb-boot-${bootId}-${i}`}
          aria-label={`View photo ${i + 1} for boot ${bootId}`}
        >
          <img
            src={src}
            alt={`Evidence ${i + 1}`}
            className="h-full w-full object-cover"
          />
        </button>
      ))}
      {extra > 0 && (
        <span className="text-xs font-medium text-muted-foreground">
          +{extra}
        </span>
      )}
    </div>
  );
}

// ---------- enforcement queue ----------
const ENFORCEMENT_FILTERS = [
  { value: "booted", label: "Booted" },
  { value: "settled", label: "Settled" },
  { value: "completed", label: "Completed" },
  { value: "released", label: "Released" },
  { value: "all", label: "All" },
] as const;

type EnforcementFilter = (typeof ENFORCEMENT_FILTERS)[number]["value"];

function EnforcementView({
  boots,
  loading,
  isPending,
  onSetStatus,
  onOpenSettle,
  onView,
}: {
  boots: Boot[];
  loading: boolean;
  isPending: boolean;
  onSetStatus: (
    id: string,
    status: BootStatus,
    amountCollected?: number,
  ) => void;
  onOpenSettle: (b: Boot) => void;
  onView: (src: string) => void;
}) {
  const [filter, setFilter] = useState<EnforcementFilter>("booted");

  const sorted = useMemo(
    () =>
      [...boots].sort(
        (a, b) =>
          new Date(b.bootedAt).getTime() - new Date(a.bootedAt).getTime(),
      ),
    [boots],
  );

  const counts = useMemo(() => {
    const c: Record<EnforcementFilter, number> = {
      all: sorted.length,
      booted: 0,
      settled: 0,
      completed: 0,
      released: 0,
    };
    for (const b of sorted) {
      const s = b.status as BootStatus;
      if (s in c) c[s as EnforcementFilter] += 1;
    }
    return c;
  }, [sorted]);

  const rows =
    filter === "all"
      ? sorted
      : sorted.filter((b) => (b.status as BootStatus) === filter);

  const outstanding = sorted
    .filter((b) => (b.status as BootStatus) === "booted")
    .reduce((sum, b) => sum + (b.bootFee || 0), 0);
  const collected = sorted.reduce(
    (sum, b) => sum + (b.amountCollected || 0),
    0,
  );

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gavel className="h-4 w-4 text-primary" />
              Enforcement Queue
            </CardTitle>
            <CardDescription>
              Review active boots and apply enforcement. Booted vehicles move to
              Released, Settled, or Completed once resolved.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>
              Outstanding:{" "}
              <strong
                className="text-foreground tabular-nums"
                data-testid="text-outstanding"
              >
                {currency(outstanding)}
              </strong>
            </span>
            <span>
              Collected:{" "}
              <strong
                className="text-foreground tabular-nums"
                data-testid="text-queue-collected"
              >
                {currency(collected)}
              </strong>
            </span>
          </div>
        </div>
        <Tabs
          value={filter}
          onValueChange={(v) => setFilter(v as EnforcementFilter)}
        >
          <TabsList className="flex-wrap">
            {ENFORCEMENT_FILTERS.map((f) => (
              <TabsTrigger
                key={f.value}
                value={f.value}
                data-testid={`tab-filter-${f.value}`}
              >
                {f.label}
                <span className="ml-1.5 tabular-nums text-muted-foreground">
                  {counts[f.value]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {loading ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Gavel className="h-8 w-8 text-muted-foreground/50" />}
            title={
              filter === "booted"
                ? "No active boots"
                : `No ${filter === "all" ? "" : STATUS_META[filter as BootStatus].label.toLowerCase() + " "}boots`
            }
            subtitle="Place a boot from the Daily view to start enforcement."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plate</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Photos</TableHead>
                  <TableHead className="text-right">Fee / Collected</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => {
                  const status = b.status as BootStatus;
                  const active = status === "booted";
                  return (
                    <TableRow key={b.id} data-testid={`row-enforce-${b.id}`}>
                      <TableCell className="whitespace-nowrap font-mono font-medium uppercase">
                        {b.licensePlate}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          <Car className="h-4 w-4 shrink-0 text-muted-foreground" />
                          {b.makeModel}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {format(parseISO(b.bootedAt), "MMM d, h:mm a")}
                        </span>
                        {(b.createdByName || b.lastActionByName) && (
                          <span
                            className="block text-xs text-muted-foreground"
                            data-testid={`text-audit-${b.id}`}
                          >
                            {b.createdByName && <>placed by {b.createdByName}</>}
                            {b.lastActionByName &&
                              b.lastActionByName !== b.createdByName && (
                                <> · last: {b.lastActionByName}</>
                              )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={status}
                          testid={`badge-status-${b.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <PhotoThumbs
                          photos={b.photos ?? []}
                          bootId={b.id}
                          onView={onView}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        <span data-testid={`text-fee-${b.id}`}>
                          {currency(b.bootFee || 0)}
                        </span>
                        {(b.amountCollected || 0) > 0 && (
                          <span
                            className="block text-xs text-muted-foreground"
                            data-testid={`text-collected-${b.id}`}
                          >
                            {currency(b.amountCollected)} collected
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {active ? (
                            <>
                              <Button
                                size="sm"
                                disabled={isPending}
                                onClick={() => onSetStatus(b.id, "completed")}
                                data-testid={`button-complete-${b.id}`}
                              >
                                <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                                Complete
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isPending}
                                onClick={() => onOpenSettle(b)}
                                data-testid={`button-settle-${b.id}`}
                              >
                                <Handshake className="mr-1 h-3.5 w-3.5" />
                                Settle
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isPending}
                                onClick={() => onSetStatus(b.id, "released")}
                                data-testid={`button-release-${b.id}`}
                              >
                                <Unlock className="mr-1 h-3.5 w-3.5" />
                                Release
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={isPending}
                              onClick={() => onSetStatus(b.id, "booted")}
                              data-testid={`button-reopen-${b.id}`}
                            >
                              <RotateCcw className="mr-1 h-3.5 w-3.5" />
                              Re-open
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatCard({
  icon,
  label,
  value,
  testid,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  testid: string;
  accent?: boolean;
}) {
  return (
    <Card className={accent ? "border-amber-500/40" : undefined}>
      <CardContent className="flex items-center gap-4 p-5">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
            accent
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : "bg-primary/10 text-primary"
          }`}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {value === null ? (
            <Skeleton className="mt-1 h-7 w-20" />
          ) : (
            <p className="text-xl font-bold tabular-nums" data-testid={testid}>
              {value}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {icon}
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
}

type HistoryDay = {
  day: string;
  isToday: boolean;
  bootCount: number;
  fees: number;
  paidCount: number;
  enforcement: number;
};

function HistoryView({
  days,
  loading,
  fetching,
  onRefresh,
  onOpenDay,
}: {
  days: HistoryDay[];
  loading: boolean;
  fetching: boolean;
  onRefresh: () => void;
  onOpenDay: (day: string) => void;
}) {
  const totals = days.reduce(
    (acc, d) => {
      acc.boots += d.bootCount;
      acc.paid += d.paidCount;
      acc.enforcement += d.enforcement;
      acc.fees += d.fees;
      return acc;
    },
    { boots: 0, paid: 0, enforcement: 0, fees: 0 },
  );

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <HistoryIcon className="h-4 w-4 text-primary" />
              {days.length >= 30
                ? "Last 30 Days"
                : `Last ${days.length} ${days.length === 1 ? "Day" : "Days"}`}
            </CardTitle>
            <CardDescription>
              Booted, paid, and enforcement counts per day. Click a day to open it.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={fetching}
            data-testid="button-refresh-history"
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${fetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <TableSkeleton />
        ) : (
          <div>
            {/* Mobile: stacked cards — every metric visible, no horizontal scroll */}
            <div className="space-y-3 sm:hidden">
              {days.map((d) => (
                <button
                  key={d.day}
                  type="button"
                  onClick={() => onOpenDay(d.day)}
                  className="w-full rounded-md border bg-card p-3 text-left"
                  data-testid={`row-history-${d.day}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium">
                      {format(parseISO(d.day + "T00:00:00"), "EEE, MMM d")}
                      {d.isToday && (
                        <Badge
                          className="border-transparent bg-primary/15 text-primary hover:bg-primary/15"
                          data-testid={`badge-today-${d.day}`}
                        >
                          Today
                        </Badge>
                      )}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Booted
                      </div>
                      <div className="text-sm font-semibold tabular-nums">
                        {d.bootCount}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Paid
                      </div>
                      <div className="text-sm font-semibold tabular-nums">
                        {d.paidCount}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Enforce
                      </div>
                      <div
                        className={`text-sm font-semibold tabular-nums ${
                          d.enforcement > 0
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {d.enforcement}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Fees
                      </div>
                      <div className="text-sm font-semibold tabular-nums">
                        {d.fees > 0 ? currency(d.fees) : "—"}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            {/* Desktop: full table */}
            <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Booted</TableHead>
                  <TableHead className="text-right">Paid (Stripe)</TableHead>
                  <TableHead className="text-right">Enforcement</TableHead>
                  <TableHead className="text-right">Fees</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {days.map((d) => (
                  <TableRow
                    key={d.day}
                    className="cursor-pointer"
                    onClick={() => onOpenDay(d.day)}
                    data-testid={`row-history-desktop-${d.day}`}
                  >
                    <TableCell className="whitespace-nowrap font-medium">
                      <span className="flex items-center gap-2">
                        {format(parseISO(d.day + "T00:00:00"), "EEE, MMM d")}
                        {d.isToday && (
                          <Badge
                            className="border-transparent bg-primary/15 text-primary hover:bg-primary/15"
                          >
                            Today
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.bootCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.paidCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.enforcement > 0 ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {d.enforcement}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.fees > 0 ? currency(d.fees) : "—"}
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t pt-3 text-sm text-muted-foreground">
              <span>
                {days.length >= 30
                  ? "30-day totals"
                  : `${days.length}-day totals`}{" "}
                — Booted:{" "}
                <strong className="text-foreground tabular-nums">
                  {totals.boots}
                </strong>
              </span>
              <span>
                Paid:{" "}
                <strong className="text-foreground tabular-nums">
                  {totals.paid}
                </strong>
              </span>
              <span>
                Enforcement:{" "}
                <strong className="text-foreground tabular-nums">
                  {totals.enforcement}
                </strong>
              </span>
              <span>
                Fees:{" "}
                <strong className="text-foreground tabular-nums">
                  {currency(totals.fees)}
                </strong>
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- boot requests ----------
// Attendants submit boot requests (a flag for an enforcer to act on). Enforcers
// and admins work the pending queue: initiate (creates a real boot) or dismiss.
const requestFormSchema = insertBootRequestSchema;
type RequestFormValues = z.infer<typeof requestFormSchema>;

function RequestsView({
  requests,
  loading,
  canWork,
  canRequest,
  isPending,
  submitPending,
  onSubmit,
  onResolve,
  onView,
}: {
  requests: BootRequest[];
  loading: boolean;
  canWork: boolean;
  canRequest: boolean;
  isPending: boolean;
  submitPending: boolean;
  onSubmit: (values: InsertBootRequest) => void;
  onResolve: (
    id: number,
    action: "initiate" | "dismiss",
    bootFee?: number,
  ) => void;
  onView: (src: string) => void;
}) {
  const form = useForm<RequestFormValues>({
    resolver: zodResolver(requestFormSchema),
    defaultValues: {
      licensePlate: "",
      makeModel: "",
      suggestedFee: 0,
      note: "",
      photos: [],
    },
  });

  // Initiate dialog: enforcer confirms / overrides the fee before booting.
  const [initiate, setInitiate] = useState<BootRequest | null>(null);
  const [initiateFee, setInitiateFee] = useState<string>("");

  const sorted = useMemo(
    () =>
      [...requests].sort(
        (a, b) =>
          new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
      ),
    [requests],
  );
  const pending = sorted.filter((r) => r.status === "pending");
  const resolved = sorted.filter((r) => r.status !== "pending");

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
      {/* Submit form (attendants/admins) */}
      {canRequest && (
        <Card className="h-fit lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="h-4 w-4 text-primary" />
              Request a Boot
            </CardTitle>
            <CardDescription>
              Flag a vehicle for booting. It enters the pending queue for an
              enforcer to initiate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit((v) => {
                  onSubmit(v);
                  form.reset({
                    licensePlate: "",
                    makeModel: "",
                    suggestedFee: 0,
                    note: "",
                    photos: [],
                  });
                })}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="licensePlate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>License Plate</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="ABC-1234"
                          autoComplete="off"
                          className="uppercase"
                          data-testid="input-request-plate"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="makeModel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Make &amp; Model</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Honda Civic"
                          autoComplete="off"
                          data-testid="input-request-makemodel"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="suggestedFee"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Suggested Fee{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                            $
                          </span>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="0.00"
                            className="pl-7"
                            data-testid="input-request-fee"
                            {...field}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="note"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Note{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          placeholder="Blocking a reserved spot, no permit, etc."
                          data-testid="input-request-note"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="photos"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Evidence Photos{" "}
                        <span className="font-normal text-muted-foreground">
                          (up to {MAX_BOOT_PHOTOS})
                        </span>
                      </FormLabel>
                      <FormControl>
                        <PhotoUploadField
                          value={field.value ?? []}
                          onChange={field.onChange}
                          onView={onView}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitPending}
                  data-testid="button-submit-request"
                >
                  {submitPending ? "Submitting…" : "Submit request"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      )}

      {/* Queue */}
      <Card className={canRequest ? "" : "lg:col-span-2"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Inbox className="h-4 w-4 text-primary" />
            {canWork ? "Pending Requests" : "My Requests"}
            {pending.length > 0 && (
              <Badge variant="secondary" data-testid="text-pending-total">
                {pending.length} pending
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {canWork
              ? "Initiate creates an active boot; dismiss closes the request."
              : "Track the boot requests you've submitted."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <TableSkeleton />
          ) : sorted.length === 0 ? (
            <EmptyState
              icon={<Inbox className="h-8 w-8 text-muted-foreground/50" />}
              title="No boot requests"
              subtitle={
                canRequest
                  ? "Submit a request using the form."
                  : "Requests submitted by attendants will appear here."
              }
            />
          ) : (
            <>
              {/* Pending section */}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Pending ({pending.length})
                </p>
                {pending.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing pending right now.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {pending.map((r) => (
                      <div
                        key={r.id}
                        className="rounded-md border p-3"
                        data-testid={`row-request-${r.id}`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-mono font-semibold uppercase">
                              {r.licensePlate}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {r.makeModel}
                            </p>
                            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              {format(parseISO(r.requestedAt), "MMM d, h:mm a")}
                              {r.requestedByName && (
                                <span data-testid={`text-requested-by-${r.id}`}>
                                  {" "}
                                  · by {r.requestedByName}
                                </span>
                              )}
                            </p>
                            {(r.suggestedFee ?? 0) > 0 && (
                              <p className="mt-1 text-xs">
                                Suggested fee:{" "}
                                <span className="font-medium tabular-nums">
                                  {currency(r.suggestedFee)}
                                </span>
                              </p>
                            )}
                            {r.note && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                “{r.note}”
                              </p>
                            )}
                            {r.photos && r.photos.length > 0 && (
                              <div className="mt-2">
                                <PhotoThumbs
                                  photos={r.photos}
                                  bootId={r.id}
                                  onView={onView}
                                />
                              </div>
                            )}
                          </div>
                          {canWork && (
                            <div className="flex shrink-0 flex-wrap gap-1.5">
                              <Button
                                size="sm"
                                disabled={isPending}
                                onClick={() => {
                                  setInitiate(r);
                                  setInitiateFee(
                                    (r.suggestedFee ?? 0) > 0
                                      ? String(r.suggestedFee)
                                      : "",
                                  );
                                }}
                                data-testid={`button-initiate-${r.id}`}
                              >
                                <Gavel className="mr-1 h-3.5 w-3.5" />
                                Initiate
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isPending}
                                onClick={() => onResolve(r.id, "dismiss")}
                                data-testid={`button-dismiss-${r.id}`}
                              >
                                <Ban className="mr-1 h-3.5 w-3.5" />
                                Dismiss
                              </Button>
                            </div>
                          )}
                          {!canWork && (
                            <Badge
                              variant="secondary"
                              className="gap-1"
                              data-testid={`badge-request-status-${r.id}`}
                            >
                              <Clock className="h-3 w-3" />
                              Pending
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Resolved section */}
              {resolved.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Resolved ({resolved.length})
                  </p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Plate</TableHead>
                          <TableHead>Vehicle</TableHead>
                          <TableHead>Requested by</TableHead>
                          <TableHead>Outcome</TableHead>
                          <TableHead>Resolved by</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {resolved.map((r) => (
                          <TableRow
                            key={r.id}
                            data-testid={`row-resolved-${r.id}`}
                          >
                            <TableCell className="font-mono font-semibold uppercase">
                              {r.licensePlate}
                            </TableCell>
                            <TableCell>{r.makeModel}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {r.requestedByName || "—"}
                            </TableCell>
                            <TableCell>
                              {r.status === "initiated" ? (
                                <Badge
                                  className="gap-1 border-transparent bg-primary/15 text-primary hover:bg-primary/15"
                                  data-testid={`badge-outcome-${r.id}`}
                                >
                                  <Gavel className="h-3 w-3" />
                                  Booted
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="gap-1 text-muted-foreground"
                                  data-testid={`badge-outcome-${r.id}`}
                                >
                                  <Ban className="h-3 w-3" />
                                  Dismissed
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {r.resolvedByName || "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Initiate dialog */}
      <Dialog
        open={initiate !== null}
        onOpenChange={(open) => !open && setInitiate(null)}
      >
        <DialogContent data-testid="dialog-initiate">
          <DialogHeader>
            <DialogTitle>Initiate boot</DialogTitle>
            <DialogDescription>
              {initiate && (
                <>
                  Place a boot on{" "}
                  <span className="font-mono font-semibold uppercase">
                    {initiate.licensePlate}
                  </span>{" "}
                  ({initiate.makeModel}). Confirm the fee to charge.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="initiate-fee">Boot fee ($)</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <Input
                id="initiate-fee"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                className="pl-7"
                value={initiateFee}
                onChange={(e) => setInitiateFee(e.target.value)}
                data-testid="input-initiate-fee"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setInitiate(null)}
              data-testid="button-initiate-cancel"
            >
              Cancel
            </Button>
            <Button
              disabled={isPending}
              onClick={() => {
                if (!initiate) return;
                const fee = parseFloat(initiateFee);
                onResolve(
                  initiate.id,
                  "initiate",
                  Number.isFinite(fee) && fee >= 0 ? fee : undefined,
                );
                setInitiate(null);
              }}
              data-testid="button-initiate-confirm"
            >
              {isPending ? "Booting…" : "Initiate boot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- user management (admin only) ----------
const newUserSchema = createUserSchema;
type NewUserValues = z.infer<typeof newUserSchema>;

// Admin-only control for the history-visibility window. Staff (enforcers +
// attendants) can only see this many days back within the 30-day retention
// window; admins always see the full 30. Keeps older payment history private.
function SettingsCard({
  historyVisibleDays,
  showFinancialsToStaff,
}: {
  historyVisibleDays: number;
  showFinancialsToStaff: boolean;
}) {
  const { toast } = useToast();
  // Local draft so the Select reflects edits before saving.
  const [draft, setDraft] = useState<number>(historyVisibleDays);

  // Keep the draft in sync if the server value changes (e.g. first load).
  useEffect(() => {
    setDraft(historyVisibleDays);
  }, [historyVisibleDays]);

  const save = useMutation({
    mutationFn: async (days: number) => {
      const res = await apiRequest("PATCH", "/api/settings", {
        historyVisibleDays: days,
      });
      return res.json();
    },
    onSuccess: () => {
      // Refresh everything the window affects.
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/boots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/paid-cars"] });
      toast({
        title: "History window saved",
        description: "Staff visibility has been updated.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not save setting",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Financial-visibility toggle. Saves immediately on flip.
  const saveFinancials = useMutation({
    mutationFn: async (show: boolean) => {
      const res = await apiRequest("PATCH", "/api/settings", {
        showFinancialsToStaff: show,
      });
      return res.json();
    },
    onSuccess: (_d, show) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Financial visibility saved",
        description: show
          ? "Staff can now see the financial summary cards."
          : "Financial summary cards are hidden from staff.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not save setting",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const dirty = draft !== historyVisibleDays;
  // Friendly summary of what the current draft means for staff.
  const summary =
    draft <= 1
      ? "Staff see today and the previous day only."
      : `Staff see today plus the previous ${draft} days (${draft + 1} days total).`;

  return (
    <Card data-testid="card-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <EyeOff className="h-4 w-4 text-primary" />
          History Visibility
        </CardTitle>
        <CardDescription>
          Limit how many days of history staff can see within the 30-day
          window. Admins always see the full 30 days. Lower this to keep older
          payment history private from enforcers and attendants.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="history-days" className="text-sm font-medium">
              Days visible to staff
            </Label>
            <Select
              value={String(draft)}
              onValueChange={(v) => setDraft(Number(v))}
            >
              <SelectTrigger
                id="history-days"
                className="w-[200px]"
                data-testid="select-history-days"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {Array.from({ length: 30 }, (_, i) => i + 1).map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n === 1
                      ? "1 day back (today + yesterday)"
                      : `${n} days back`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => save.mutate(draft)}
            disabled={!dirty || save.isPending}
            data-testid="button-save-settings"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p
          className="mt-3 text-sm text-muted-foreground"
          data-testid="text-history-summary"
        >
          {summary}
        </p>

        {/* Financial privacy toggle: hide revenue/payment cards from staff. */}
        <div className="mt-5 border-t pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label
                htmlFor="show-financials"
                className="flex items-center gap-2 text-sm font-medium"
              >
                <DollarSign className="h-4 w-4 text-primary" />
                Show financial summary to staff
              </Label>
              <p className="max-w-md text-sm text-muted-foreground">
                Off by default. When off, staff (enforcers and attendants) do
                not see the Cars booted, Collected, or Paid via Stripe summary
                cards — keeping daily financial counts confidential. Admins
                always see them.
              </p>
            </div>
            <Switch
              id="show-financials"
              checked={showFinancialsToStaff}
              disabled={saveFinancials.isPending}
              onCheckedChange={(v) => saveFinancials.mutate(v)}
              data-testid="switch-show-financials"
            />
          </div>
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="text-financials-summary"
          >
            {showFinancialsToStaff
              ? "Staff currently SEE the financial summary cards."
              : "Staff currently do NOT see the financial summary cards (admin only)."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function UsersView({
  users,
  loading,
  currentUserId,
}: {
  users: User[];
  loading: boolean;
  currentUserId?: number;
}) {
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<Role>("attendant");
  const [editPassword, setEditPassword] = useState("");
  const [editActive, setEditActive] = useState(true);

  const createForm = useForm<NewUserValues>({
    resolver: zodResolver(newUserSchema),
    defaultValues: {
      username: "",
      name: "",
      password: "",
      role: "attendant",
    },
  });

  const createUser = useMutation({
    mutationFn: async (values: CreateUserInput) => {
      const res = await apiRequest("POST", "/api/users", values);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      createForm.reset({
        username: "",
        name: "",
        password: "",
        role: "attendant",
      });
      setShowCreate(false);
      toast({ title: "User created", description: "The account is ready." });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not create user",
        description: err.message.includes("409")
          ? "That username is already taken."
          : err.message,
        variant: "destructive",
      });
    },
  });

  const updateUser = useMutation({
    mutationFn: async (vars: {
      id: number;
      body: Record<string, unknown>;
    }) => {
      const res = await apiRequest("PATCH", `/api/users/${vars.id}`, vars.body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setEditing(null);
      toast({ title: "User updated" });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not update user",
        description: err.message.includes("400")
          ? "Can't remove the last active admin."
          : err.message,
        variant: "destructive",
      });
    },
  });

  function openEdit(u: User) {
    setEditing(u);
    setEditName(u.name);
    setEditRole(u.role as Role);
    setEditPassword("");
    setEditActive(Boolean(u.active));
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <UsersIcon className="h-4 w-4 text-primary" />
              User Management
            </CardTitle>
            <CardDescription>
              Create accounts and assign roles. Admins manage everything;
              enforcers run enforcement and log payments; attendants request
              boots.
            </CardDescription>
          </div>
          <Button
            variant={showCreate ? "secondary" : "default"}
            size="sm"
            onClick={() => setShowCreate((s) => !s)}
            data-testid="button-toggle-create-user"
          >
            <UserPlus className="mr-1.5 h-4 w-4" />
            Add user
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Create form */}
        {showCreate && (
          <div
            className="rounded-md border bg-muted/30 p-4"
            data-testid="form-create-user"
          >
            <Form {...createForm}>
              <form
                onSubmit={createForm.handleSubmit((v) => createUser.mutate(v))}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <FormField
                  control={createForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Jane Doe"
                          autoComplete="off"
                          data-testid="input-newuser-name"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Username</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="jane"
                          autoComplete="off"
                          data-testid="input-newuser-username"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Temporary password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="min 6 characters"
                          autoComplete="new-password"
                          data-testid="input-newuser-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-newuser-role">
                            <SelectValue placeholder="Select role" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem
                              key={r}
                              value={r}
                              data-testid={`option-role-${r}`}
                            >
                              {ROLE_LABELS[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex items-center gap-2 sm:col-span-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={createUser.isPending}
                    data-testid="button-create-user"
                  >
                    {createUser.isPending ? "Creating…" : "Create user"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowCreate(false)}
                    data-testid="button-create-user-cancel"
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </Form>
          </div>
        )}

        {loading ? (
          <TableSkeleton />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                    <TableCell className="font-medium">
                      {u.name}
                      {u.id === currentUserId && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          (you)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {u.username}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="gap-1">
                        <ShieldCheck className="h-3 w-3" />
                        {ROLE_LABELS[u.role as Role]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {u.active ? (
                        <Badge
                          className="gap-1 border-transparent bg-primary/15 text-primary hover:bg-primary/15"
                          data-testid={`badge-user-active-${u.id}`}
                        >
                          <Check className="h-3 w-3" />
                          Active
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="gap-1 text-muted-foreground"
                          data-testid={`badge-user-active-${u.id}`}
                        >
                          <Ban className="h-3 w-3" />
                          Disabled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(u)}
                        data-testid={`button-edit-user-${u.id}`}
                      >
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Edit dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent data-testid="dialog-edit-user">
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>
              {editing && (
                <>
                  Update <strong>{editing.username}</strong>. Leave password
                  blank to keep it unchanged.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Full name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                data-testid="input-edit-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select
                value={editRole}
                onValueChange={(v) => setEditRole(v as Role)}
              >
                <SelectTrigger id="edit-role" data-testid="select-edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem
                      key={r}
                      value={r}
                      data-testid={`option-edit-role-${r}`}
                    >
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-password">New password</Label>
              <Input
                id="edit-password"
                type="password"
                placeholder="Leave blank to keep current"
                autoComplete="new-password"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                data-testid="input-edit-password"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="edit-active" className="text-sm font-medium">
                  Account active
                </Label>
                <p className="text-xs text-muted-foreground">
                  Disabled users cannot sign in.
                </p>
              </div>
              <Switch
                id="edit-active"
                checked={editActive}
                onCheckedChange={setEditActive}
                data-testid="switch-edit-active"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setEditing(null)}
              data-testid="button-edit-user-cancel"
            >
              Cancel
            </Button>
            <Button
              disabled={updateUser.isPending}
              onClick={() => {
                if (!editing) return;
                const body: Record<string, unknown> = {
                  name: editName.trim(),
                  role: editRole,
                  active: editActive,
                };
                if (editPassword.trim().length > 0) {
                  body.password = editPassword.trim();
                }
                updateUser.mutate({ id: editing.id, body });
              }}
              data-testid="button-edit-user-save"
            >
              {updateUser.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
