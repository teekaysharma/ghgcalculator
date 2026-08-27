import type { User as SchemaUser, Membership } from "@shared/schema";

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface User extends SchemaUser {}

    interface Request {
      /**
       * Set by requireOrg middleware (server/middleware/tenant.ts) after
       * resolving the caller's membership for the organization implied by
       * the request. Never trust a client-supplied organization id without
       * going through that middleware first.
       */
      organizationId?: number;
      membership?: Membership;
    }
  }
}

export {};
