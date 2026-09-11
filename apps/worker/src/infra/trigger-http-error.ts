/**
 * A refusal a service decided, carrying the exact HTTP answer the route must
 * send.
 *
 * The status and message are part of a provider's contract with us: Jira retries
 * a 503 and gives up on a 401, so they are behaviour, not presentation. The route
 * still owns the translation into an H3 error, which is why this is a plain error
 * class and not `createError`: no service reaches for the server runtime.
 *
 * It lives below the clusters because more than one of them throws it. When it
 * sat inside the triggers cluster, the email and Slack services could only reach
 * it through that cluster's interface, and the interface carries the dispatcher
 * and with it the whole engine graph: two webhook routes that run no step were
 * loading 36 step modules to name one error class.
 */
export class TriggerHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly statusMessage: string,
    /** Body the provider sees alongside the status, when there is one to send. */
    readonly data?: Record<string, unknown>,
  ) {
    super(statusMessage);
    this.name = "TriggerHttpError";
  }
}
