/**
 * The invest settings and limits: the API's address, the signing page's and the watch's times, and the longest an
 * authorization may stay valid, kept here so each is set in one place and never written at a call site.
 */
export const INVEST = {
  /**
   * The latest an authorization may expire, counted from now. An authorization is a signature that
   * moves funds; one that stays valid for days is a standing permission, not a withdrawal the owner
   * is making now. The provider issues them for minutes.
   */
  maxAuthorizationLifetimeSeconds: 60 * 60,
  /**
   * The Tempora API every `invest` call goes to. Pinned here: the sign-in message must name this host, so a
   * message for any other is refused before it is signed. `TREASURY_API_URL` points `invest` at another deployment.
   */
  apiUrl: "https://api.temporalabs.com",
  /** How long one API call may take before it is reported as unanswered. */
  apiTimeoutMs: 30_000,
  /** How long the signing page stays open for one command: a sign-in, an enrolment and a transfer, with time to read each. */
  pageTtlMs: 20 * 60_000,
  /**
   * How long a command keeps reading a request after the owner's last step, waiting for it to settle (a transfer to
   * land, a withdrawal to run). Past it the command reports the request as still running; `invest request` reads it later.
   */
  watchMs: 5 * 60_000,
  /** How often a request is read while it settles. */
  pollMs: 5_000,
  /** The most steps one command will put to the wallet; a request asking for more is refused, never followed. */
  maxSteps: 12,
} as const;
