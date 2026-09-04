import { useState } from "react";
import { Link, useSearchParams } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [newPassword, setNewPassword] = useState("");

  const resetPassword = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/reset-password", { token, newPassword });
    },
  });

  if (!token) {
    return (
      <AuthLayout heading="Invalid link" subheading="This password reset link is missing its token.">
        <p className="text-sm text-neutral-600 text-center">
          <Link href="/forgot-password" className="text-primary font-medium hover:underline">
            Request a new link
          </Link>
        </p>
      </AuthLayout>
    );
  }

  if (resetPassword.isSuccess) {
    return (
      <AuthLayout heading="Password updated" subheading="You're all set.">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-neutral-700">
            <CheckCircle2 className="h-8 w-8 text-primary shrink-0" />
            <p>Your password has been updated — you can log in now.</p>
          </div>
          <Button asChild className="w-full">
            <Link href="/login">Log in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout heading="Set a new password" subheading="Choose a new password for your account.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          resetPassword.mutate();
        }}
        className="space-y-4"
      >
        {resetPassword.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {(resetPassword.error as Error)?.message || "This link is invalid or has expired."}
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="newPassword">New password</Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={resetPassword.isPending || newPassword.length < 8}>
          {resetPassword.isPending ? "Updating..." : "Set new password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
