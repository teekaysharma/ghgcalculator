import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";

interface TeamMember {
  id: number;
  userId: number;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  isActive: boolean;
  accountIsActive: boolean;
  createdAt: string;
}

interface TeamActionLogEntry {
  id: number;
  actorEmail: string;
  action: string;
  targetEmail: string;
  note: string | null;
  createdAt: string;
}

export default function TeamPanel() {
  const { organizations } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState("");
  const [membershipNotes, setMembershipNotes] = useState<Record<number, string>>({});
  const [deactivateNotes, setDeactivateNotes] = useState<Record<number, string>>({});
  const [resetPasswordNotes, setResetPasswordNotes] = useState<Record<number, string>>({});
  const [changeEmailDrafts, setChangeEmailDrafts] = useState<Record<number, { email: string; note: string }>>({});

  const role = organizations[0]?.role;
  const canManage = role === "owner" || role === "admin";

  const teamQuery = useQuery<{ members: TeamMember[] }>({ queryKey: ["/api/team"] });
  const actionLogQuery = useQuery<{ entries: TeamActionLogEntry[] }>({
    queryKey: ["/api/team/action-log"],
    enabled: canManage,
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/team"] });
    queryClient.invalidateQueries({ queryKey: ["/api/team/action-log"] });
  }

  const invite = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/team/invite", { email: inviteEmail });
      return res.json();
    },
    onSuccess: () => {
      setInviteEmail("");
      invalidateAll();
      toast({ title: "Added to team" });
    },
    onError: (err) => toast({ title: "Could not add member", description: err.message, variant: "destructive" }),
  });

  const deactivateMembership = useMutation({
    mutationFn: async ({ membershipId, note }: { membershipId: number; note: string }) => {
      const res = await apiRequest("POST", `/api/team/memberships/${membershipId}/deactivate`, { note });
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
      const res = await apiRequest("POST", `/api/team/memberships/${membershipId}/activate`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Membership reactivated" });
    },
    onError: (err) => toast({ title: "Could not reactivate membership", description: err.message, variant: "destructive" }),
  });

  const deactivateAccount = useMutation({
    mutationFn: async ({ userId, note }: { userId: number; note: string }) => {
      const res = await apiRequest("POST", `/api/team/members/${userId}/deactivate`, { note });
      return res.json();
    },
    onSuccess: (_data, { userId }) => {
      invalidateAll();
      setDeactivateNotes((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      toast({ title: "Account deactivated" });
    },
    onError: (err) => toast({ title: "Could not deactivate account", description: err.message, variant: "destructive" }),
  });

  const reactivateAccount = useMutation({
    mutationFn: async (userId: number) => {
      const res = await apiRequest("POST", `/api/team/members/${userId}/reactivate`);
      return res.json();
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Account reactivated" });
    },
    onError: (err) => toast({ title: "Could not reactivate account", description: err.message, variant: "destructive" }),
  });

  const changeEmail = useMutation({
    mutationFn: async ({ userId, newEmail, note }: { userId: number; newEmail: string; note: string }) => {
      const res = await apiRequest("POST", `/api/team/members/${userId}/change-email`, { newEmail, note });
      return res.json();
    },
    onSuccess: (_data, { userId }) => {
      invalidateAll();
      setChangeEmailDrafts((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      toast({ title: "Email changed — a reset link was sent to the new address" });
    },
    onError: (err) => toast({ title: "Could not change email", description: err.message, variant: "destructive" }),
  });

  const resetPassword = useMutation({
    mutationFn: async ({ userId, note }: { userId: number; note: string }) => {
      const res = await apiRequest("POST", `/api/team/members/${userId}/reset-password`, { note });
      return res.json();
    },
    onSuccess: (_data, { userId }) => {
      invalidateAll();
      setResetPasswordNotes((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      toast({ title: "Password reset email sent" });
    },
    onError: (err) => toast({ title: "Could not send password reset", description: err.message, variant: "destructive" }),
  });

  const members = teamQuery.data?.members ?? [];
  const entries = actionLogQuery.data?.entries ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team</CardTitle>
          <CardDescription>
            {canManage
              ? "Add, deactivate, or manage members of your organization."
              : "Members of your organization."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {members.length === 0 && !teamQuery.isLoading && (
            <p className="text-sm text-neutral-500">No team members found.</p>
          )}
          {members.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.name || "-"}</TableCell>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">{m.role}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1 text-xs">
                          <span className="text-neutral-500">Membership:</span>
                          {m.isActive ? (
                            <Badge variant="secondary">Active</Badge>
                          ) : (
                            <Badge variant="destructive">Deactivated</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-xs">
                          <span className="text-neutral-500">Account:</span>
                          {m.accountIsActive ? (
                            <Badge variant="secondary">Active</Badge>
                          ) : (
                            <Badge variant="destructive">Deactivated</Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex flex-wrap gap-2 justify-end">
                          {m.isActive ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="sm" className="text-destructive">
                                  Deactivate membership
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Deactivate {m.email}'s membership?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This revokes their access to your organization only. A reason is required.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <div className="py-2 space-y-2">
                                  <Label htmlFor={`membership-note-${m.id}`}>Reason</Label>
                                  <Textarea
                                    id={`membership-note-${m.id}`}
                                    value={membershipNotes[m.id] ?? ""}
                                    onChange={(e) =>
                                      setMembershipNotes((prev) => ({ ...prev, [m.id]: e.target.value }))
                                    }
                                  />
                                </div>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    disabled={!membershipNotes[m.id]?.trim()}
                                    onClick={() =>
                                      deactivateMembership.mutate({ membershipId: m.id, note: membershipNotes[m.id]!.trim() })
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
                              onClick={() => activateMembership.mutate(m.id)}
                              disabled={activateMembership.isPending}
                            >
                              Reactivate membership
                            </Button>
                          )}
                          {m.accountIsActive ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="sm" className="text-destructive">
                                  Deactivate account
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Deactivate {m.email}'s account?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This blocks their login entirely. Only available if they belong to no other
                                    organization — otherwise a super-admin is required. A reason is required.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <div className="py-2 space-y-2">
                                  <Label htmlFor={`deactivate-note-${m.userId}`}>Reason</Label>
                                  <Textarea
                                    id={`deactivate-note-${m.userId}`}
                                    value={deactivateNotes[m.userId] ?? ""}
                                    onChange={(e) =>
                                      setDeactivateNotes((prev) => ({ ...prev, [m.userId]: e.target.value }))
                                    }
                                  />
                                </div>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    disabled={!deactivateNotes[m.userId]?.trim()}
                                    onClick={() =>
                                      deactivateAccount.mutate({ userId: m.userId, note: deactivateNotes[m.userId]!.trim() })
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
                              onClick={() => reactivateAccount.mutate(m.userId)}
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
                                <AlertDialogTitle>Change {m.email}'s email?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  A password-set link is emailed to the new address — nobody types or shares a
                                  password. Only available if they belong to no other organization. A reason is
                                  required.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <div className="py-2 space-y-3">
                                <div className="space-y-2">
                                  <Label htmlFor={`new-email-${m.userId}`}>New email</Label>
                                  <Input
                                    id={`new-email-${m.userId}`}
                                    type="email"
                                    value={changeEmailDrafts[m.userId]?.email ?? ""}
                                    onChange={(e) =>
                                      setChangeEmailDrafts((prev) => ({
                                        ...prev,
                                        [m.userId]: { email: e.target.value, note: prev[m.userId]?.note ?? "" },
                                      }))
                                    }
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`change-email-note-${m.userId}`}>Reason</Label>
                                  <Textarea
                                    id={`change-email-note-${m.userId}`}
                                    value={changeEmailDrafts[m.userId]?.note ?? ""}
                                    onChange={(e) =>
                                      setChangeEmailDrafts((prev) => ({
                                        ...prev,
                                        [m.userId]: { email: prev[m.userId]?.email ?? "", note: e.target.value },
                                      }))
                                    }
                                  />
                                </div>
                              </div>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  disabled={
                                    !changeEmailDrafts[m.userId]?.email?.trim() || !changeEmailDrafts[m.userId]?.note?.trim()
                                  }
                                  onClick={() =>
                                    changeEmail.mutate({
                                      userId: m.userId,
                                      newEmail: changeEmailDrafts[m.userId]!.email.trim(),
                                      note: changeEmailDrafts[m.userId]!.note.trim(),
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
                                <AlertDialogTitle>Send {m.email} a password reset link?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Nobody types or sees their new password — they set it themselves via the emailed
                                  link. A reason is required.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <div className="py-2 space-y-2">
                                <Label htmlFor={`reset-password-note-${m.userId}`}>Reason</Label>
                                <Textarea
                                  id={`reset-password-note-${m.userId}`}
                                  value={resetPasswordNotes[m.userId] ?? ""}
                                  onChange={(e) =>
                                    setResetPasswordNotes((prev) => ({ ...prev, [m.userId]: e.target.value }))
                                  }
                                />
                              </div>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  disabled={!resetPasswordNotes[m.userId]?.trim()}
                                  onClick={() =>
                                    resetPassword.mutate({ userId: m.userId, note: resetPasswordNotes[m.userId]!.trim() })
                                  }
                                >
                                  Send reset link
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {canManage && (
            <div className="flex gap-2 pt-2 border-t border-neutral-100">
              <Input
                type="email"
                placeholder="teammate@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="max-w-xs"
              />
              <Button onClick={() => invite.mutate()} disabled={!inviteEmail || invite.isPending}>
                {invite.isPending ? "Adding..." : "Add"}
              </Button>
            </div>
          )}
          <p className="text-xs text-neutral-400">
            The person must already have an account. There's no email invite yet, they need to register themselves first,
            then you can add them here.
          </p>
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>The most recent admin actions within your organization.</CardDescription>
          </CardHeader>
          <CardContent>
            {!actionLogQuery.isLoading && entries.length === 0 && (
              <p className="text-sm text-neutral-500">No admin actions recorded yet.</p>
            )}
            {entries.length > 0 && (
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
                      <TableCell className="capitalize">{e.action.replace(/_/g, " ")}</TableCell>
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
      )}
    </div>
  );
}
