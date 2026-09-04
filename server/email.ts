import { Resend } from "resend";

// Verification and password-reset emails. If this app ever needs other
// transactional email (invites), add another sibling function here rather
// than overloading either of these -- see the file-level pattern in
// server/vite.ts / server/vite-dev.ts for why this project prefers one
// clear responsibility per file over a growing grab-bag module.

if (!process.env.RESEND_API_KEY) {
  throw new Error(
    "RESEND_API_KEY is not set. Sign up at resend.com, create an API key, and set it as RESEND_API_KEY in your .env file (see .env.example).",
  );
}
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.EMAIL_FROM || "onboarding@resend.dev";

export async function sendVerificationEmail(params: {
  to: string;
  token: string;
  requestOrigin: string;
}): Promise<void> {
  const { to, token, requestOrigin } = params;
  const verifyUrl = `${requestOrigin}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Verify your email — GHG Emissions Calculator",
    html: `
      <p>Thanks for signing up for the GHG Emissions Calculator.</p>
      <p><a href="${verifyUrl}">Click here to verify your email address</a>.</p>
      <p>This link expires in 24 hours. If you don't verify by then, this registration will be automatically removed and you'll need to sign up again.</p>
      <p>If you didn't create this account, you can safely ignore this email.</p>
    `,
  });

  if (error) {
    throw new Error(`Resend failed to send verification email: ${error.message}`);
  }
}

// Used for self-service "forgot password", admin-triggered password reset,
// and email-change (which reuses this same token instead of an admin ever
// typing or sharing a password -- see
// docs/superpowers/specs/2026-09-04-membership-lifecycle-management-design.md).
// POST /api/auth/reset-password also marks the account verified on success,
// so this one email/link does double duty for the email-change case.
export async function sendPasswordResetEmail(params: {
  to: string;
  token: string;
  requestOrigin: string;
}): Promise<void> {
  const { to, token, requestOrigin } = params;
  const resetUrl = `${requestOrigin}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Reset your password — GHG Emissions Calculator",
    html: `
      <p>Use the link below to set a new password for your GHG Emissions Calculator account.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a>.</p>
      <p>This link expires in 24 hours.</p>
      <p>If you didn't request this, you can safely ignore this email -- your password won't change unless you click the link and set a new one.</p>
    `,
  });

  if (error) {
    throw new Error(`Resend failed to send password reset email: ${error.message}`);
  }
}
