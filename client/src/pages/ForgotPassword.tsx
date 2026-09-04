import { useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const forgotPassword = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/forgot-password", { email });
    },
    onSuccess: () => setSubmitted(true),
  });

  if (submitted) {
    return (
      <AuthLayout heading="Check your email" subheading="If that account exists, a reset link is on its way.">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-neutral-700">
            <CheckCircle2 className="h-8 w-8 text-primary shrink-0" />
            <p>We've sent a password reset link to {email} — check your inbox (and spam folder).</p>
          </div>
          <p className="text-sm text-neutral-600 text-center">
            <Link href="/login" className="text-primary font-medium hover:underline">
              Back to log in
            </Link>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout heading="Forgot your password?" subheading="Enter your email and we'll send you a reset link.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          forgotPassword.mutate();
        }}
        className="space-y-4"
      >
        {forgotPassword.isError && (
          <Alert variant="destructive">
            <AlertDescription>Something went wrong — try again.</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={forgotPassword.isPending || !email}>
          {forgotPassword.isPending ? "Sending..." : "Send reset link"}
        </Button>
      </form>
      <p className="text-sm text-neutral-600 mt-6 text-center">
        <Link href="/login" className="text-primary font-medium hover:underline">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  );
}
