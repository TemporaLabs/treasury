/**
 * The invest limits: the numbers the portfolio-withdrawal gate (`src/invest/gate.ts`) holds an
 * authorization to, kept here so they are set in one place and never written at a call site.
 */
export const INVEST = {
  /**
   * The latest an authorization may expire, counted from now. An authorization is a signature that
   * moves funds; one that stays valid for days is a standing permission, not a withdrawal the owner
   * is making now. The provider issues them for minutes.
   */
  maxAuthorizationLifetimeSeconds: 60 * 60,
} as const;
