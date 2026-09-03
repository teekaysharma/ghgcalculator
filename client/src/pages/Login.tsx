import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import AuthLayout from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";

const loginFormSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginFormSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const { login, loginPending } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = async (values: LoginFormValues) => {
    setError(null);
    setUnverifiedEmail(null);
    try {
      await login(values);
      setLocation("/");
    } catch (err) {
      const reason = (err as Error & { reason?: string }).reason;
      if (reason === "unverified") {
        setUnverifiedEmail(values.email);
      } else {
        setError(err instanceof Error ? err.message : "Failed to log in");
      }
    }
  };

  const resend = async () => {
    if (!unverifiedEmail) return;
    setResendState("sending");
    try {
      await apiRequest("POST", "/api/auth/resend-verification-email", { email: unverifiedEmail });
    } finally {
      setResendState("sent");
    }
  };

  return (
    <AuthLayout heading="Welcome back" subheading="Sign in to continue tracking your organization's emissions.">
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {unverifiedEmail && (
          <Alert>
            <AlertDescription className="space-y-2">
              <p>Please verify your email before logging in.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={resend}
                disabled={resendState === "sending"}
              >
                {resendState === "sending" ? "Sending..." : resendState === "sent" ? "Sent — check your inbox" : "Resend verification email"}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
          {form.formState.errors.email && (
            <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} />
          {form.formState.errors.password && (
            <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={loginPending}>
          {loginPending ? "Signing in..." : "Log in"}
        </Button>
      </form>
      <p className="text-sm text-neutral-600 mt-6 text-center">
        Don't have an account?{" "}
        <Link href="/register" className="text-primary font-medium hover:underline">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
}
