import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcryptjs";
import { storage } from "./storage";

const SALT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// passport-local authenticates against email + password. On success it
// hands back the raw User row; req.user is populated from this. It does NOT
// resolve which organization the request is for -- that's a separate step
// (see server/middleware/tenant.ts) because a user can belong to more than
// one organization via the memberships table.
passport.use(
  new LocalStrategy({ usernameField: "email", passwordField: "password" }, async (email, password, done) => {
    try {
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return done(null, false, { message: "Invalid email or password" });
      }
      const valid = await comparePassword(password, user.passwordHash);
      if (!valid) {
        return done(null, false, { message: "Invalid email or password" });
      }
      if (!user.emailVerified) {
        return done(
          null,
          false,
          { message: "Please verify your email before logging in.", reason: "unverified" } as {
            message: string;
            reason: string;
          },
        );
      }
      if (!user.isActive) {
        return done(
          null,
          false,
          { message: "This account has been deactivated. Contact your organization admin or support.", reason: "deactivated" } as {
            message: string;
            reason: string;
          },
        );
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }),
);

passport.serializeUser((user: Express.User, done) => {
  done(null, (user as { id: number }).id);
});

// Re-fetches the full user row on every request rather than trusting anything
// cached on the session -- which is why an isSuperAdmin promotion takes effect
// immediately, and why requireOrg's fresh getActiveMembershipsForUser lookup can
// make a membership deactivation bite on the very next request.
//
// isActive gets the same treatment (2026-09-09, final-review finding I1).
// deactivateAccount only flipped users.isActive, and nothing re-checked it for
// an already-authenticated session: the LocalStrategy above blocks LOGIN, but an
// existing session cookie (7-day lifetime) kept full access afterwards --
// including /admin, if the deactivated account happened to be a super-admin.
// That inverted the product's own claim, leaving account-wide deactivation
// weaker in practice than the per-organization membership deactivation it is
// supposed to subsume. done(null, false) here is the same signal passport
// already gets for "no such user", so req.isAuthenticated() is false on the next
// request and requireAuth rejects it with no route-level changes.
//
// Scope note: this deliberately does not reach into connect-pg-simple's session
// table to delete rows. It does not need to. passport's own session strategy
// (node_modules/passport/lib/strategies/session.js) responds to a falsy
// deserializeUser result with `delete req.session[key].user` -- so the first
// request a deactivated account makes strips the user id out of its own session
// record, permanently. That cookie is logged out for good: reactivating the
// account does NOT revive it, and the user has to log in again (which the
// LocalStrategy above then allows, since is_active is true again). Verified
// live -- see scenario 31 in scripts/verify-admin-panel.mjs, which asserts the
// cookie stays dead after reactivation rather than assuming it recovers.
passport.deserializeUser(async (id: number, done) => {
  try {
    const user = await storage.getUser(id);
    if (!user) return done(null, false);
    if (!user.isActive) return done(null, false);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

export { passport };
