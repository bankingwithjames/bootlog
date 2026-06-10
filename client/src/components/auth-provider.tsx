import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { queryClient, apiRequest, setAuthToken, setOnUnauthorized } from "@/lib/queryClient";
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
  // Token is in-memory only (iframe blocks storage), so there's no session to
  // restore on mount. We start unauthenticated; loading is only true during a
  // login round-trip.
  const [loading, setLoading] = useState(false);

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
        logPaidCar: Boolean(role), // any signed-in user
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
