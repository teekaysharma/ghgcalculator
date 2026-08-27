import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";

interface AuthUser {
  id: number;
  email: string;
  name: string | null;
}

interface Membership {
  id: number;
  userId: number;
  organizationId: number;
  role: "owner" | "admin" | "member";
  createdAt: string;
}

interface OrgSummary {
  organizationId: number;
  role: "owner" | "admin" | "member";
  name: string | null;
  slug: string | null;
  enabledModules: string[];
}

interface MeResponse {
  user: AuthUser;
  memberships: Membership[];
  organizations: OrgSummary[];
}

interface RegisterInput {
  email: string;
  password: string;
  name?: string;
  organizationName: string;
}

interface LoginInput {
  email: string;
  password: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  memberships: Membership[];
  organizations: OrgSummary[];
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  loginPending: boolean;
  registerPending: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // on401: "returnNull" -- not being logged in is a normal, expected state
  // here (every visitor starts out this way), not an error to throw.
  const meQuery = useQuery<MeResponse | null>({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const loginMutation = useMutation({
    mutationFn: async (input: LoginInput) => {
      const res = await apiRequest("POST", "/api/auth/login", input);
      return res.json();
    },
    // Awaited so mutateAsync doesn't resolve (and callers don't navigate)
    // until the auth/me refetch has actually landed -- otherwise
    // ProtectedRoute reads the still-stale unauthenticated cache and
    // bounces straight back to /login even though the session is valid.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });

  const registerMutation = useMutation({
    mutationFn: async (input: RegisterInput) => {
      const res = await apiRequest("POST", "/api/auth/register", input);
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      // Clear everything, not just /api/auth/me -- a fresh session as a
      // different user (or logged out entirely) should never see another
      // tenant's cached data.
      queryClient.clear();
    },
  });

  const value: AuthContextValue = {
    user: meQuery.data?.user ?? null,
    memberships: meQuery.data?.memberships ?? [],
    organizations: meQuery.data?.organizations ?? [],
    isLoading: meQuery.isLoading,
    isAuthenticated: !!meQuery.data?.user,
    login: async (input) => {
      await loginMutation.mutateAsync(input);
    },
    register: async (input) => {
      await registerMutation.mutateAsync(input);
    },
    logout: async () => {
      await logoutMutation.mutateAsync();
    },
    loginPending: loginMutation.isPending,
    registerPending: registerMutation.isPending,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
