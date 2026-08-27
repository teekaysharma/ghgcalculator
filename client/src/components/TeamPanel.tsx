import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface TeamMember {
  id: number;
  userId: number;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  createdAt: string;
}

export default function TeamPanel() {
  const { organizations } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState("");

  const role = organizations[0]?.role;
  const canInvite = role === "owner" || role === "admin";

  const teamQuery = useQuery<{ members: TeamMember[] }>({ queryKey: ["/api/team"] });

  const invite = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/team/invite", { email: inviteEmail });
      return res.json();
    },
    onSuccess: () => {
      setInviteEmail("");
      queryClient.invalidateQueries({ queryKey: ["/api/team"] });
      toast({ title: "Added to team" });
    },
    onError: (err) => toast({ title: "Could not add member", description: err.message, variant: "destructive" }),
  });

  const members = teamQuery.data?.members ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Team</CardTitle>
        <CardDescription>
          {canInvite
            ? "Add an existing account to your organization by email."
            : "Members of your organization."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between text-sm border-b border-neutral-100 pb-2 last:border-0">
              <div>
                <span className="font-medium">{m.name || m.email}</span>
                {m.name && <span className="text-neutral-500 ml-2">{m.email}</span>}
              </div>
              <Badge variant="secondary" className="capitalize">{m.role}</Badge>
            </div>
          ))}
          {members.length === 0 && !teamQuery.isLoading && (
            <p className="text-sm text-neutral-500">No team members found.</p>
          )}
        </div>

        {canInvite && (
          <div className="flex gap-2">
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
  );
}
