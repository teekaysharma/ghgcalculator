import { Resend } from "resend";

// Verification emails only. If this app ever needs other transactional
// email (password reset, invites), add a sibling function here rather than
// overloading this one -- see the file-level pattern in server/vite.ts /
// server/vite-dev.ts for why this project prefers one clear responsibility
// per file over a growing grab-bag module.

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
