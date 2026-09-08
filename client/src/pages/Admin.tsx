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
  membershipId: number;
  organizationId: number;
  organizationName: string;
  role: string;
  isActive: boolean;
}

interface AdminUserListItem {
  id: number;
  email: string;
  name: string | null;
  emailVerified: boolean;
  isSuperAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  organizations: AdminOrgSummary[];
}

interface AdminActionLogEntry {
  id: number;
  actorEmail: string;
  action:
    | "verify"
    | "delete"
    | "promote"
    | "demote"
    | "deactivate_membership"
    | "activate_membership"
    | "deactivate_user"
    | "activate_user"
    | "change_email"
    | "reset_password";
  targetEmail: string;
  organizationName: string | null;
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
  // Per-row draft text/state for dialogs that need one, keyed by the row's
  // own id (membership id for membership actions, user id for account
  // actions) -- each row's AlertDialog is a separate mounted instance, so
  // this needs to be keyed rather than a single shared value.
  const [demoteNotes, setDemoteNotes] = useState<Record<number, string>>({});
  const [membershipNotes, setMembershipNotes] = useState<Record<number, string>>({});
  const [deactivateNotes, setDeactivateNotes] = useState<Record<number, string>>({});
  const [resetPasswordNotes, setResetPasswordNotes] = useState<Record<number, string>>({});
  const [changeEmailDrafts, setChangeEmailDrafts] = useState<Record<number, { email: string; note: string }>>({});

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

  const deactivateMembership = useMutation({
    mutationFn: async ({ membershipId, note }: { membershipId: number; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/memberships/${membershipId}/deactivate`, { note });
      return res.json();
    },
    onSuccess: (_data, { membershipId }) => {
      invalidateAll();
      setMembershipNotes((prev) => {
        const next = { ...prev };
        delete next[membershipId];
        return next;
      });
      toast({ title: "Membership deactivated" });
    },
    onError: (err) => toast({ title: "Could not deactivate membership", description: err.message, variant: "destructive" }),
  });

  const activateMembership = useMutation({
    mutationFn: async (membershipId: number) => {
      const res = await apiRequest("POST", `/api/admin/memberships/${membershipId}/activate`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Membership reactivated" });
    },
    onError: (err) => toast({ title: "Could not reactivate membership", description: err.message, variant: "destructive" }),
  });

  const deactivateAccount = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/deactivate`, { note });
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidateAll();
      setDeactivateNotes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast({ title: "Account deactivated" });
    },
    onError: (err) => toast({ title: "Could not deactivate account", description: err.message, variant: "destructive" }),
  });

  const reactivateAccount = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/reactivate`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Account reactivated" });
    },
    onError: (err) => toast({ title: "Could not reactivate account", description: err.message, variant: "destructive" }),
  });

  const changeEmail = useMutation({
    mutationFn: async ({ id, newEmail, note }: { id: number; newEmail: string; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/change-email`, { newEmail, note });
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidateAll();
      setChangeEmailDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast({ title: "Email changed — a reset link was sent to the new address" });
    },
    onError: (err) => toast({ title: "Could not change email", description: err.message, variant: "destructive" }),
  });

  const resetPassword = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      const res = await apiRequest("POST", `/api/admin/users/${id}/reset-password`, { note });
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidateAll();
      setResetPasswordNotes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast({ title: "Password reset email sent" });
    },
    onError: (err) => toast({ title: "Could not send password reset", description: err.message, variant: "destructive" }),
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
                    const isSelf = u.id === user.id;
                    return (
                      <TableRow key={u.id}>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>{u.name ?? "-"}</TableCell>
                        <TableCell>
                          {!u.emailVerified ? (
                            <Badge variant="outline">Pending</Badge>
                          ) : !u.isActive ? (
                            <Badge variant="destructive">Deactivated</Badge>
                          ) : u.isSuperAdmin ? (
                            <Badge variant="default">Super Admin</Badge>
                          ) : (
                            <Badge variant="secondary">Verified</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {u.organizations.length === 0 && "—"}
                          <div className="space-y-1">
                            {u.organizations.map((org) => (
                              <div key={org.membershipId} className="flex items-center gap-2 text-sm">
                                <span>{org.organizationName}</span>
                                <Badge variant={org.isActive ? "secondary" : "outline"} className="capitalize">
                                  {org.role}
                                </Badge>
                                {org.isActive ? (
                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                                        Deactivate
                                      </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>
                                          Deactivate {u.email}'s access to {org.organizationName}?
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                          This revokes their access to this organization only, not any other org they
                                          belong to. A reason is required.
                                        </AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <div className="py-2 space-y-2">
                                        <Label htmlFor={`membership-note-${org.membershipId}`}>Reason</Label>
                                        <Textarea
                                          id={`membership-note-${org.membershipId}`}
                                          value={membershipNotes[org.membershipId] ?? ""}
                                          onChange={(e) =>
                                            setMembershipNotes((prev) => ({ ...prev, [org.membershipId]: e.target.value }))
                                          }
                                        />
                                      </div>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction
                                          disabled={!membershipNotes[org.membershipId]?.trim()}
                                          onClick={() =>
                                            deactivateMembership.mutate({
                                              membershipId: org.membershipId,
                                              note: membershipNotes[org.membershipId]!.trim(),
                                            })
                                          }
                                        >
                                          Deactivate
                                        </AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                ) : (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    onClick={() => activateMembership.mutate(org.membershipId)}
                                    disabled={activateMembership.isPending}
                                  >
                                    Reactivate
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                        </TableCell>
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
                          {u.emailVerified && !isSelf && (
                            <div className="flex flex-wrap gap-2 justify-end mt-1">
                              {u.isActive ? (
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button variant="ghost" size="sm" className="text-destructive">
                                      Deactivate account
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Deactivate {u.email}'s account?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        This blocks login entirely, regardless of which organizations they belong to.
                                        A reason is required and is recorded in the activity log.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <div className="py-2 space-y-2">
                                      <Label htmlFor={`deactivate-note-${u.id}`}>Reason</Label>
                                      <Textarea
                                        id={`deactivate-note-${u.id}`}
                                        value={deactivateNotes[u.id] ?? ""}
                                        onChange={(e) =>
                                          setDeactivateNotes((prev) => ({ ...prev, [u.id]: e.target.value }))
                                        }
                                      />
                                    </div>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                                      <AlertDialogAction
                                        disabled={!deactivateNotes[u.id]?.trim()}
                                        onClick={() =>
                                          deactivateAccount.mutate({ id: u.id, note: deactivateNotes[u.id]!.trim() })
                                        }
                                      >
                                        Deactivate
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => reactivateAccount.mutate(u.id)}
                                  disabled={reactivateAccount.isPending}
                                >
                                  Reactivate account
                                </Button>
                              )}
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    Change email
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Change {u.email}'s email?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      A password-set link is emailed to the new address — nobody types or shares a
                                      password. The account is re-verified when they use it. A reason is required.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <div className="py-2 space-y-3">
                                    <div className="space-y-2">
                                      <Label htmlFor={`new-email-${u.id}`}>New email</Label>
                                      <Input
                                        id={`new-email-${u.id}`}
                                        type="email"
                                        value={changeEmailDrafts[u.id]?.email ?? ""}
                                        onChange={(e) =>
                                          setChangeEmailDrafts((prev) => ({
                                            ...prev,
                                            [u.id]: { email: e.target.value, note: prev[u.id]?.note ?? "" },
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <Label htmlFor={`change-email-note-${u.id}`}>Reason</Label>
                                      <Textarea
                                        id={`change-email-note-${u.id}`}
                                        value={changeEmailDrafts[u.id]?.note ?? ""}
                                        onChange={(e) =>
                                          setChangeEmailDrafts((prev) => ({
                                            ...prev,
                                            [u.id]: { email: prev[u.id]?.email ?? "", note: e.target.value },
                                          }))
                                        }
                                      />
                                    </div>
                                  </div>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      disabled={
                                        !changeEmailDrafts[u.id]?.email?.trim() || !changeEmailDrafts[u.id]?.note?.trim()
                                      }
                                      onClick={() =>
                                        changeEmail.mutate({
                                          id: u.id,
                                          newEmail: changeEmailDrafts[u.id]!.email.trim(),
                                          note: changeEmailDrafts[u.id]!.note.trim(),
                                        })
                                      }
                                    >
                                      Change email
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    Reset password
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Send {u.email} a password reset link?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Nobody types or sees their new password — they set it themselves via the emailed
                                      link. A reason is required.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <div className="py-2 space-y-2">
                                    <Label htmlFor={`reset-password-note-${u.id}`}>Reason</Label>
                                    <Textarea
                                      id={`reset-password-note-${u.id}`}
                                      value={resetPasswordNotes[u.id] ?? ""}
                                      onChange={(e) =>
                                        setResetPasswordNotes((prev) => ({ ...prev, [u.id]: e.target.value }))
                                      }
                                    />
                                  </div>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      disabled={!resetPasswordNotes[u.id]?.trim()}
                                      onClick={() =>
                                        resetPassword.mutate({ id: u.id, note: resetPasswordNotes[u.id]!.trim() })
                                      }
                                    >
                                      Send reset link
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
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
                    <TableHead>Organization</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{e.actorEmail}</TableCell>
                      <TableCell className="capitalize">{e.action.replace(/_/g, " ")}</TableCell>
                      <TableCell>{e.targetEmail}</TableCell>
                      <TableCell>{e.organizationName ?? "—"}</TableCell>
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
