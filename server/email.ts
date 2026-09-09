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

// Used for self-service "forgot password" and admin-triggered password reset,
// where the account is otherwise untouched and the recipient may genuinely not
// have asked for anything. The admin/org-admin change-email routes used to
// reuse this function too; they now call sendEmailChangedByAdminEmail below,
// because this email's closing "you can safely ignore this" line is the exact
// opposite of the truth once an account's address has already been reassigned.
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

// The change-email sibling of sendPasswordResetEmail, added because sharing one
// body between the two was actively misleading (2026-09-09, final-review
// finding I4). Both links are the same password-reset token by design -- an
// admin never types or shares a password -- but the situations are opposites:
//
//   forgot-password / admin reset-password: nothing about the account has
//   changed, so a recipient who didn't ask for it can ignore the mail safely.
//
//   change-email: the account's address has ALREADY been reassigned to this
//   inbox and, because storage.setNewEmailPendingVerification sets
//   email_verified = false, login is blocked for everyone until this link is
//   used (POST /api/auth/reset-password marks the account verified again on
//   success). "You can safely ignore this email" is false here in both
//   directions: ignoring it leaves the account unreachable, and if the
//   recipient wasn't expecting it, someone has just pointed an existing account
//   at their address -- which is worth escalating, not dismissing.
export async function sendEmailChangedByAdminEmail(params: {
  to: string;
  token: string;
  requestOrigin: string;
}): Promise<void> {
  const { to, token, requestOrigin } = params;
  const resetUrl = `${requestOrigin}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Action needed: your GHG Emissions Calculator account email was changed",
    html: `
      <p>An administrator has changed the email address on a GHG Emissions Calculator account to this one (${to}). That change has already been applied.</p>
      <p>Nobody can log in to the account until you set a password from the link below, which also confirms this address:</p>
      <p><a href="${resetUrl}">Click here to set a password and confirm this address</a>.</p>
      <p>This link expires in 24 hours.</p>
      <p>If you weren't expecting this, don't ignore it — an existing account now points at your address. Contact your organization's administrator or support.</p>
    `,
  });

  if (error) {
    throw new Error(`Resend failed to send email-changed notice: ${error.message}`);
  }
}
