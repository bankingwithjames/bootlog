import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format, parseISO } from "date-fns";
import {
  Car,
  Plus,
  Trash2,
  Moon,
  Sun,
  ParkingMeter,
  DollarSign,
  CalendarDays,
} from "lucide-react";

import { insertBootSchema, type Boot } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useTheme } from "@/components/theme-provider";
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

// Helpers for <input type="datetime-local"> which produces "YYYY-MM-DDTHH:mm"
function nowLocalInput(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

const formSchema = insertBootSchema.extend({
  licensePlate: z.string().trim().min(1, "License plate is required"),
  makeModel: z.string().trim().min(1, "Make & model is required"),
  bootedAt: z.string().min(1, "Date & time is required"),
  feePaid: z.coerce.number().min(0, "Fee can't be negative"),
});
type FormValues = z.infer<typeof formSchema>;

function currency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <ParkingMeter className="h-5 w-5" strokeWidth={2.2} />
      </span>
      <div className="leading-tight">
        <span className="block text-base font-bold tracking-tight">BootLog</span>
        <span className="block text-xs text-muted-foreground">
          Boot Attendant Log
        </span>
      </div>
    </div>
  );
}

export default function Home() {
  const { theme, toggle } = useTheme();
  const { toast } = useToast();

  // Date filter: default to today (local).
  const [filterDate, setFilterDate] = useState<string>(() =>
    format(new Date(), "yyyy-MM-dd"),
  );

  const { data: boots = [], isLoading } = useQuery<Boot[]>({
    queryKey: ["/api/boots"],
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      licensePlate: "",
      makeModel: "",
      bootedAt: nowLocalInput(),
      feePaid: 0,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      // datetime-local has no timezone; store as full ISO.
      const payload = {
        ...values,
        bootedAt: new Date(values.bootedAt).toISOString(),
      };
      const res = await apiRequest("POST", "/api/boots", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/boots"] });
      form.reset({
        licensePlate: "",
        makeModel: "",
        bootedAt: nowLocalInput(),
        feePaid: 0,
      });
      toast({ title: "Boot logged", description: "Vehicle added to the log." });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not log boot",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/boots/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/boots"] });
      toast({ title: "Removed", description: "Boot record deleted." });
    },
  });

  // Monthly stats (current calendar month, based on local time).
  const now = new Date();
  const monthLabel = format(now, "MMMM yyyy");
  const monthly = useMemo(() => {
    let count = 0;
    let fees = 0;
    for (const b of boots) {
      const d = parseISO(b.bootedAt);
      if (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth()
      ) {
        count += 1;
        fees += b.feePaid;
      }
    }
    return { count, fees };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boots]);

  // Rows filtered by the selected date.
  const filtered = useMemo(() => {
    return boots.filter(
      (b) => format(parseISO(b.bootedAt), "yyyy-MM-dd") === filterDate,
    );
  }, [boots, filterDate]);

  const dayCount = filtered.length;
  const dayFees = filtered.reduce((s, b) => s + b.feePaid, 0);
  const filterLabel =
    filterDate === format(new Date(), "yyyy-MM-dd")
      ? "Today"
      : format(parseISO(filterDate + "T00:00:00"), "EEE, MMM d, yyyy");

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Logo />
          <Button
            variant="outline"
            size="icon"
            onClick={toggle}
            aria-label="Toggle dark mode"
            data-testid="button-theme-toggle"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {/* Monthly summary */}
        <section className="mb-6">
          <h1 className="mb-1 text-xl font-bold tracking-tight">
            Boot Attendant Dashboard
          </h1>
          <p className="mb-4 text-sm text-muted-foreground">
            Log every booted vehicle and track totals for {monthLabel}.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              icon={<ParkingMeter className="h-5 w-5" />}
              label={`Cars booted · ${monthLabel}`}
              value={isLoading ? null : String(monthly.count)}
              testid="stat-month-count"
            />
            <StatCard
              icon={<DollarSign className="h-5 w-5" />}
              label={`Fees collected · ${monthLabel}`}
              value={isLoading ? null : currency(monthly.fees)}
              testid="stat-month-fees"
            />
            <StatCard
              icon={<CalendarDays className="h-5 w-5" />}
              label={`Booted · ${filterLabel}`}
              value={isLoading ? null : `${dayCount} · ${currency(dayFees)}`}
              testid="stat-day"
            />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
          {/* Add form */}
          <Card className="h-fit lg:sticky lg:top-20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plus className="h-4 w-4 text-primary" />
                Log a Booted Car
              </CardTitle>
              <CardDescription>
                Enter the vehicle details and fee collected.
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
                          <Input
                            type="datetime-local"
                            data-testid="input-datetime"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="feePaid"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Fee Paid ($)</FormLabel>
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
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={createMutation.isPending}
                    data-testid="button-submit"
                  >
                    {createMutation.isPending ? "Saving…" : "Add Boot"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          {/* Table + date filter */}
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Car className="h-4 w-4 text-primary" />
                  Booted Vehicles
                </CardTitle>
                <CardDescription>
                  {filterLabel} · {dayCount} vehicle{dayCount === 1 ? "" : "s"}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="filter-date" className="text-sm whitespace-nowrap">
                  Date
                </Label>
                <Input
                  id="filter-date"
                  type="date"
                  value={filterDate}
                  onChange={(e) => setFilterDate(e.target.value)}
                  className="w-auto"
                  data-testid="input-filter-date"
                />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
                  <ParkingMeter className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium">No boots logged for {filterLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    Add a vehicle using the form, or pick a different date.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>License Plate</TableHead>
                        <TableHead>Make &amp; Model</TableHead>
                        <TableHead className="whitespace-nowrap">Time</TableHead>
                        <TableHead className="text-right">Fee Paid</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((b) => (
                        <TableRow key={b.id} data-testid={`row-boot-${b.id}`}>
                          <TableCell className="font-mono font-semibold uppercase">
                            {b.licensePlate}
                          </TableCell>
                          <TableCell>{b.makeModel}</TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {format(parseISO(b.bootedAt), "h:mm a")}
                          </TableCell>
                          <TableCell className="text-right">
                            {b.feePaid > 0 ? (
                              <span
                                className="font-medium tabular-nums"
                                data-testid={`text-fee-${b.id}`}
                              >
                                {currency(b.feePaid)}
                              </span>
                            ) : (
                              <Badge variant="outline" className="font-normal">
                                Unpaid
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
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
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="mt-3 flex justify-end border-t pt-3 text-sm">
                    <span className="text-muted-foreground">
                      Total collected ({filterLabel}):&nbsp;
                    </span>
                    <span className="font-semibold tabular-nums" data-testid="text-day-total">
                      {currency(dayFees)}
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Fees are recorded manually. Stripe payment integration can be connected
          later.
        </p>
      </main>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  testid,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  testid: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
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
