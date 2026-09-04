import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface AdminOrgSummary {
  organizationId: number;
  organizationName: string;
  role: string;
}

interface AdminUserListItem {
  id: number;
  email: string;
  name: string | null;
  emailVerified: boolean;
  isSuperAdmin: boolean;
  createdAt: string;
  organizations: AdminOrgSummary[];
}

interface AdminActionLogEntry {
  id: number;
  actorEmail: string;
  action: "verify" | "delete" | "promote" | "demote";
  targetEmail: string;
  note: string | null;
  createdAt: string;
}

const PAGE_SIZE = 25;

export default function Admin() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  // Per-row draft text for the demote reason, keyed by user id -- each
  // row's AlertDialog is a separate mounted instance, so this needs to be
  // keyed rather than a single shared string.
  const [demoteNotes, setDemoteNotes] = useState<Record<number, string>>({});

  // Auth-only gating is handled by ProtectedRoute (App.tsx). This is the
  // extra, super-admin-only gate: redirect a logged-in but non-admin user
  // straight back to the app, same loading/redirect shape as
  // ProtectedRoute itself.
  useEffect(() => {
    if (!isLoading && user && !user.isSuperAdmin) {
      setLocation("/");
    }
  }, [isLoading, user, setLocation]);

  // Debounce the search box, and reset back to the first page whenever the
  // (debounced) search term actually changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Object-shaped query key (not the usual "queryKey[0] is the literal
  // fetch URL" convention used everywhere else in this app) so that
  // invalidateQueries({ queryKey: ["/api/admin/users"] }) below still
  // matches every search/page variant via TanStack Query's array-prefix
  // matching -- a single string key baking the querystring in would not
  // match on invalidation.
  const usersQuery = useQuery<{ users: AdminUserListItem[]; total: number }>({
    queryKey: ["/api/admin/users", { search: debouncedSearch, offset }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const res = await fetch(`/api/admin/users?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: !!user?.isSuperAdmin,
  });

  const actionLogQuery = useQuery<{ entries: AdminActionLogEntry[] }>({
    queryKey: ["/api/admin/action-log"],
    enabled: !!user?.isSuperAdmin,
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/action-log"] });
  }

  const verify = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/verify`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Account verified" });
    },
    onError: (err) => toast({ title: "Could not verify account", description: err.message, variant: "destructive" }),
  });

  const deleteUser = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/users/${id}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Registration deleted" });
    },
    onError: (err) => toast({ title: "Could not delete registration", description: err.message, variant: "destructive" }),
  });

  const promote = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/promote`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Promoted to super-admin" });
    },
    onError: (err) => toast({ title: "Could not promote account", description: err.message, variant: "destructive" }),
  });

  const demote = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/demote`, { note });
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidateAll();
      setDemoteNotes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast({ title: "Super-admin access removed" });
    },
    onError: (err) => toast({ title: "Could not demote account", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !user?.isSuperAdmin) return null;

  const rows = usersQuery.data?.users ?? [];
  const total = usersQuery.data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);
  const entries = actionLogQuery.data?.entries ?? [];

  return (
    <div className="min-h-screen bg-neutral-50 font-sans">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="font-heading font-bold text-3xl text-primary-800 mb-1">Platform Admin</h1>
            <p className="text-neutral-600 text-sm">All accounts across every organization.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setLocation("/")}>
            Back to app
          </Button>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Accounts</CardTitle>
            <CardDescription>
              Verify or delete a pending registration, promote a verified account to super-admin, or demote one.
            </CardDescription>
            <Input
              placeholder="Search by email or name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs mt-2"
            />
          </CardHeader>
          <CardContent>
            {usersQuery.isError && (
              <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
                <span className="text-destructive">
                  Couldn't load accounts. {(usersQuery.error as Error)?.message}
                </span>
                <Button variant="outline" size="sm" onClick={() => usersQuery.refetch()}>
                  Retry
                </Button>
              </div>
            )}
            {!usersQuery.isError && usersQuery.isLoading && (
              <div className="text-sm text-neutral-500">Loading...</div>
            )}
            {!usersQuery.isError && !usersQuery.isLoading && rows.length === 0 && (
              <p className="text-sm text-neutral-500">No accounts found.</p>
            )}
            {!usersQuery.isError && rows.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Registered</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((u) => {
                    const org = u.organizations[0];
                    const orgLabel = org
                      ? u.organizations.length > 1
                        ? `${org.organizationName} +${u.organizations.length - 1} more`
                        : org.organizationName
                      : "—";
                    const isSelf = u.id === user.id;
                    return (
                      <TableRow key={u.id}>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>{u.name ?? "-"}</TableCell>
                        <TableCell>
                          {!u.emailVerified ? (
                            <Badge variant="outline">Pending</Badge>
                          ) : u.isSuperAdmin ? (
                            <Badge variant="default">Super Admin</Badge>
                          ) : (
                            <Badge variant="secondary">Verified</Badge>
                          )}
                        </TableCell>
                        <TableCell>{orgLabel}</TableCell>
                        <TableCell>{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                        <TableCell>
                          {!u.emailVerified && (
                            <div className="flex gap-2 justify-end">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => verify.mutate(u.id)}
                                disabled={verify.isPending}
                              >
                                Verify
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm" className="text-destructive">
                                    Delete
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Delete this registration?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This permanently removes {u.email} and its organization. This cannot be undone.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => deleteUser.mutate(u.id)}>
                                      Delete
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                          {u.emailVerified && !u.isSuperAdmin && (
                            <div className="flex justify-end">
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    Promote to super-admin
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Promote {u.email} to super-admin?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This grants full access to every account and organization on the platform,
                                      including the ability to verify, delete, promote, and demote other accounts.
                                      This is a significant privilege grant with no built-in way to undo it from this
                                      panel.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => promote.mutate(u.id)}>
                                      Promote
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                          {u.emailVerified && u.isSuperAdmin && !isSelf && (
                            <div className="flex justify-end">
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm" className="text-destructive">
                                    Demote
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Demote {u.email}?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This removes {u.email}'s super-admin access. A reason is required and is
                                      recorded in the activity log below.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <div className="py-2 space-y-2">
                                    <Label htmlFor={`demote-note-${u.id}`}>Reason for demotion</Label>
                                    <Textarea
                                      id={`demote-note-${u.id}`}
                                      value={demoteNotes[u.id] ?? ""}
                                      onChange={(e) =>
                                        setDemoteNotes((prev) => ({ ...prev, [u.id]: e.target.value }))
                                      }
                                      placeholder="Why is this account being demoted?"
                                    />
                                  </div>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      disabled={!demoteNotes[u.id]?.trim()}
                                      onClick={() => demote.mutate({ id: u.id, note: demoteNotes[u.id]!.trim() })}
                                    >
                                      Demote
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                          {u.emailVerified && u.isSuperAdmin && isSelf && (
                            <p className="text-xs text-neutral-400 text-right">(you)</p>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {!usersQuery.isError && total > 0 && (
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-neutral-500">
                  Showing {rangeStart}–{rangeEnd} of {total}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    disabled={offset === 0}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    disabled={offset + PAGE_SIZE >= total}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>The most recent admin actions across the platform.</CardDescription>
          </CardHeader>
          <CardContent>
            {actionLogQuery.isError && (
              <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
                <span className="text-destructive">
                  Couldn't load activity. {(actionLogQuery.error as Error)?.message}
                </span>
                <Button variant="outline" size="sm" onClick={() => actionLogQuery.refetch()}>
                  Retry
                </Button>
              </div>
            )}
            {!actionLogQuery.isError && actionLogQuery.isLoading && (
              <div className="text-sm text-neutral-500">Loading...</div>
            )}
            {!actionLogQuery.isError && !actionLogQuery.isLoading && entries.length === 0 && (
              <p className="text-sm text-neutral-500">No admin actions recorded yet.</p>
            )}
            {!actionLogQuery.isError && entries.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{e.actorEmail}</TableCell>
                      <TableCell className="capitalize">{e.action}</TableCell>
                      <TableCell>{e.targetEmail}</TableCell>
                      <TableCell>{e.note ?? "—"}</TableCell>
                      <TableCell>{new Date(e.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
