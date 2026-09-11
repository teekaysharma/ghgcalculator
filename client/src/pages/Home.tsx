import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import AppShell from "@/components/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";

function SuperAdminControlPanel({ hasOrg }: { hasOrg: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [orgName, setOrgName] = useState("");

  const createOrg = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/organizations", { name: orgName });
      return res.json();
    },
    onSuccess: async () => {
      setOrgName("");
      // /api/auth/me now returns this new membership -- refetching it is
      // what makes AppShell (org-scoped, rendered below) appear at all.
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Organization created" });
    },
    onError: (err) =>
      toast({ title: "Could not create organization", description: err.message, variant: "destructive" }),
  });

  return (
    <Card className="mb-8 border-primary-200 bg-primary-50/40">
      <CardHeader>
        <CardTitle className="text-base">Super-Admin Control Panel</CardTitle>
        <CardDescription>
          Platform-wide administration — every account and organization, not just your own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button asChild>
          <Link href="/admin">Go to Admin Panel</Link>
        </Button>
        {!hasOrg && (
          <div className="pt-2 border-t border-primary-100">
            <p className="text-sm text-neutral-600 mb-2">
              You don't belong to any organization right now — that's fine, the Admin Panel above works either way.
              Optionally, create one of your own to enter data and use the app as a regular tenant would:
            </p>
            <div className="flex gap-2 max-w-sm">
              <Input placeholder="Organization name" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
              <Button
                variant="outline"
                onClick={() => createOrg.mutate()}
                disabled={!orgName.trim() || createOrg.isPending}
              >
                {createOrg.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NameEditor({ currentName }: { currentName: string | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentName ?? "");

  const saveName = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/auth/me", { name: draft });
      return res.json();
    },
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Name updated" });
    },
    onError: (err) => toast({ title: "Could not update name", description: err.message, variant: "destructive" }),
  });

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveName.mutate();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-7 text-sm w-40"
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={() => saveName.mutate()}
          disabled={saveName.isPending}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="font-medium text-neutral-800 hover:underline text-left"
      onClick={() => {
        setDraft(currentName ?? "");
        setEditing(true);
      }}
      title="Click to edit your name"
    >
      {currentName ?? "Set your name"}
    </button>
  );
}

export default function Home() {
  const { user, organizations, logout } = useAuth();
  const org = organizations[0];

  return (
    <div className="min-h-screen bg-neutral-50 font-sans">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Header */}
        <header className="mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6">
            <div>
              <h1 className="font-heading font-bold text-3xl md:text-4xl text-primary-800 mb-2 font-work-sans">
                GHG Emissions Calculator
              </h1>
              <p className="text-neutral-600">Track, calculate, and visualize your carbon footprint</p>
            </div>
            <div className="flex items-center gap-3 mt-4 md:mt-0">
              <div className="text-right text-sm">
                {org && <div className="text-neutral-800">{org.name}</div>}
                {user && (
                  <div className="flex items-center justify-end gap-2">
                    <NameEditor currentName={user.name} />
                    <span className="text-neutral-400">·</span>
                    <span className="text-neutral-500">{user.email}</span>
                  </div>
                )}
              </div>
              {user?.isSuperAdmin && (
                <Link href="/admin" className="text-sm text-primary-600 hover:underline">
                  Admin
                </Link>
              )}
              <Button variant="outline" size="sm" onClick={() => logout()}>
                Log out
              </Button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="space-y-8">
          {user?.isSuperAdmin && <SuperAdminControlPanel hasOrg={!!org} />}
          {org ? (
            <AppShell />
          ) : (
            user?.isSuperAdmin && (
              <p className="text-sm text-neutral-500">
                No organization selected — use the Admin Panel above, or create one to start tracking emissions.
              </p>
            )
          )}
        </main>

        {/* Footer */}
        <footer className="mt-10 pt-6 border-t border-neutral-200 text-neutral-600 text-sm">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <p>GHG Emissions Calculator &copy; {new Date().getFullYear()} | All rights reserved</p>
            <div className="mt-4 md:mt-0">
              <Link href="/privacy" className="text-primary-600 hover:text-primary-800 mr-4">
                Privacy Policy
              </Link>
              <Link href="/help" className="text-primary-600 hover:text-primary-800">
                Help & Support
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
