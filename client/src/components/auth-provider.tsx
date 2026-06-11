import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  queryClient,
  apiRequest,
  getAuthToken,
  setAuthToken,
  setOnUnauthorized,
} from "@/lib/queryClient";
import type { Role, User } from "@shared/schema";

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (
    username: string,
    password: string,
    rememberMe?: boolean,
  ) => Promise<void>;
  logout: () => Promise<void>;
  // Self-service password change. On success the in-memory user is updated
  // (which clears the forced-change gate).
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  // Convenience role checks used across the UI for permission gating.
  is: (...roles: Role[]) => boolean;
  isAdmin: boolean;
  isEnforcer: boolean;
  isAttendant: boolean;
  // Derived capability flags (single source of truth for what each role can do).
  can: {
    placeBoot: boolean; // place a boot directly
    requestBoot: boolean; // submit a boot request
    enforcement: boolean; // complete/settle/release/re-open
    workRequests: boolean; // initiate/dismiss boot requests
    deleteBoot: boolean; // remove a boot entry
    logPaidCar: boolean; // add a paid car
    manageUsers: boolean; // user administration
  };
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  // When the app runs outside the iframe (published), the token is persisted in
  // localStorage and seeded into queryClient on load. If a token exists we must
  // validate it against the server before showing the app, so we start in a
  // loading state and let the rehydrate effect resolve it. With no stored token
  // there's nothing to restore, so loading starts false.
  const [loading, setLoading] = useState<boolean>(() => getAuthToken() != null);

  // On mount, if a persisted token exists, validate it via GET /api/auth/me to
  // restore the session (this is what makes "keep me signed in" actually keep
  // the user signed in across reloads). On any failure we clear the token and
  // fall back to the login screen.
  useEffect(() => {
    let cancelled = false;
    const token = getAuthToken();
    if (!token) return;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/auth/me");
        const data = (await res.json()) as { user: User };
        if (!cancelled) setUser(data.user);
      } catch {
        // Expired/invalid token, or backend unreachable after retries. Clear it
        // and present the login screen.
        if (!cancelled) {
          setAuthToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const doLogout = useCallback(async () => {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } catch {
      // ignore network errors on logout
    }
    setAuthToken(null);
    setUser(null);
    queryClient.clear();
  }, []);

  // Force logout if any request 401s (token expired/revoked).
  useEffect(() => {
    setOnUnauthorized(() => {
      setAuthToken(null);
      setUser(null);
      queryClient.clear();
    });
    return () => setOnUnauthorized(null);
  }, []);

  const login = useCallback(
    async (username: string, password: string, rememberMe = false) => {
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/auth/login", {
        username,
        password,
        rememberMe,
      });
      const data = (await res.json()) as { token: string; user: User };
      setAuthToken(data.token);
      setUser(data.user);
      // Drop any cached data from a previous session before refetching.
      queryClient.clear();
    } finally {
      setLoading(false);
    }
    },
    [],
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      const res = await apiRequest("POST", "/api/auth/change-password", {
        currentPassword,
        newPassword,
      });
      const data = (await res.json()) as { user: User };
      setUser(data.user);
    },
    [],
  );

  const role = user?.role as Role | undefined;
  const is = useCallback(
    (...roles: Role[]) => (role ? roles.includes(role) : false),
    [role],
  );

  const value = useMemo<AuthState>(() => {
    const isAdmin = role === "admin";
    const isEnforcer = role === "enforcer";
    const isAttendant = role === "attendant";
    return {
      user,
      loading,
      login,
      logout: doLogout,
      changePassword,
      is,
      isAdmin,
      isEnforcer,
      isAttendant,
      can: {
        placeBoot: isAdmin || isEnforcer,
        requestBoot: isAttendant || isAdmin,
        enforcement: isAdmin || isEnforcer,
        workRequests: isAdmin || isEnforcer,
        deleteBoot: isAdmin,
        logPaidCar: isAdmin || isEnforcer || isAttendant, // logging a paid vehicle is part of the attendant's field workflow
        manageUsers: isAdmin,
      },
    };
  }, [user, loading, login, doLogout, changePassword, is, role]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
