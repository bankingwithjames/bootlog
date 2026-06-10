import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, LogIn, Moon, Sun } from "lucide-react";

import logoFull from "@assets/logo-full.png";
import { loginSchema, type LoginInput } from "@shared/schema";
import { useAuth } from "@/components/auth-provider";
import { useTheme } from "@/components/theme-provider";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

export default function Login() {
  const { login } = useAuth();
  const { theme, toggle } = useTheme();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Set the browser tab title for the login screen; restore on unmount.
  useEffect(() => {
    const previous = document.title;
    document.title = "Millennialz Parking - Login";
    return () => {
      document.title = previous;
    };
  }, []);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "", rememberMe: false },
  });

  async function onSubmit(values: LoginInput) {
    setSubmitting(true);
    try {
      await login(values.username, values.password, values.rememberMe);
      // On success the app swaps to the dashboard automatically.
    } catch (err: any) {
      const msg = String(err?.message || "");
      toast({
        title: "Sign in failed",
        description: msg.includes("401")
          ? "Invalid username or password."
          : "Could not sign in. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="absolute right-4 top-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          data-testid="button-theme-toggle"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? (
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
        </Button>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto w-40 rounded-xl bg-white p-3 ring-1 ring-border">
            <img
              src={logoFull}
              alt="Millennialz Parking, LLC — Dallas, TX"
              className="h-auto w-full object-contain"
            />
          </div>
          <div>
            <CardTitle className="text-lg" data-testid="text-login-title">
              Welcome Back
            </CardTitle>
            <CardDescription>Login to Access</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username</FormLabel>
                    <FormControl>
                      <Input
                        autoFocus
                        autoComplete="username"
                        placeholder="your username"
                        data-testid="input-username"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type={showPassword ? "text" : "password"}
                          autoComplete="current-password"
                          placeholder="••••••••"
                          className="pr-10"
                          data-testid="input-password"
                          {...field}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-r-md"
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          aria-pressed={showPassword}
                          tabIndex={-1}
                          data-testid="button-toggle-password"
                        >
                          {showPassword ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="rememberMe"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) =>
                          field.onChange(checked === true)
                        }
                        data-testid="checkbox-remember-me"
                      />
                    </FormControl>
                    <FormLabel className="cursor-pointer text-sm font-normal">
                      Keep me signed in
                      <span className="ml-1 text-muted-foreground">(48 hours)</span>
                    </FormLabel>
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full"
                disabled={submitting}
                data-testid="button-login"
              >
                <LogIn className="mr-2 h-4 w-4" />
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
