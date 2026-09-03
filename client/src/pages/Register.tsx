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

const registerFormSchema = z.object({
  organizationName: z.string().min(1, "Organization name is required"),
  name: z.string().optional(),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type RegisterFormValues = z.infer<typeof registerFormSchema>;

export default function Register() {
  const [, setLocation] = useLocation();
  const { register, registerPending } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { organizationName: "", name: "", email: "", password: "" },
  });

  const onSubmit = async (values: RegisterFormValues) => {
    setError(null);
    try {
      await register(values);
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register");
    }
  };

  return (
    <AuthLayout
      heading="Create your account"
      subheading="Set up your organization and start tracking Scope 1, 2 & 3 emissions in minutes."
    >
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="organizationName">Organization name</Label>
          <Input id="organizationName" autoComplete="organization" {...form.register("organizationName")} />
          {form.formState.errors.organizationName && (
            <p className="text-sm text-destructive">{form.formState.errors.organizationName.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Your name (optional)</Label>
          <Input id="name" autoComplete="name" {...form.register("name")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
          {form.formState.errors.email && (
            <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" {...form.register("password")} />
          {form.formState.errors.password ? (
            <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
          ) : (
            <p className="text-xs text-neutral-500">At least 8 characters.</p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={registerPending}>
          {registerPending ? "Creating account..." : "Create account"}
        </Button>
      </form>
      <p className="text-sm text-neutral-600 mt-6 text-center">
        Already have an account?{" "}
        <Link href="/login" className="text-primary font-medium hover:underline">
          Log in
        </Link>
      </p>
    </AuthLayout>
  );
}
