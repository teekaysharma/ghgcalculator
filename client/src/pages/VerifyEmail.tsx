import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

type Phase = "verifying" | "success" | "failed";

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const email = searchParams.get("email") ?? "";
  const [phase, setPhase] = useState<Phase>("verifying");
  const firedRef = useRef(false);

  const verifyMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/verify-email", { token });
    },
  });

  const resendMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/resend-verification-email", { email });
    },
  });

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    if (!token) {
      setPhase("failed");
      return;
    }
    verifyMutation.mutate(undefined, {
      onSuccess: () => setPhase("success"),
      onError: () => {
        setPhase("failed");
        if (email) resendMutation.mutate();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "verifying") {
    return (
      <AuthLayout heading="Verifying your email" subheading="This will just take a moment.">
        <div className="flex justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AuthLayout>
    );
  }

  if (phase === "success") {
    return (
      <AuthLayout heading="Email verified" subheading="Your account is ready.">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-neutral-700">
            <CheckCircle2 className="h-8 w-8 text-primary shrink-0" />
            <p>You're all set — you can log in now.</p>
          </div>
          <Button asChild className="w-full">
            <Link href="/login">Log in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout heading="That link has expired" subheading="Here's how to get back on track.">
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            {email
              ? `We've sent a fresh verification link to ${email} — check your inbox (and spam folder).`
              : "This verification link is invalid."}
          </AlertDescription>
        </Alert>
        <p className="text-sm text-neutral-600">
          Registered more than 2 days ago? That one's already been cleaned up — you'll need to start over.
        </p>
        <Button asChild className="w-full">
          <Link href="/register">Create a new account</Link>
        </Button>
        <p className="text-sm text-neutral-600 text-center">
          <Link href="/login" className="text-primary font-medium hover:underline">
            Back to log in
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
