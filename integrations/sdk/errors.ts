/**
 * A failure that retrying cannot fix: a refused credential, a resource that
 * does not exist, a request the provider rejects as invalid. Core never
 * retries a call that threw it. It matters where core calls integration code
 * from a step of its own (a capability adapter), where any other error may be
 * retried. A block executor is never retried whatever it throws, so inside a
 * block this changes nothing.
 *
 * Its `name` is `FatalError` on purpose. The Workflow DevKit, which runs every
 * core step, recognises a fatal error by that name alone, so this error stops
 * retries wherever it is thrown (inside a capability adapter called from a
 * core step, or inside a block) with no translation in between. A worker test
 * pins that DevKit behaviour.
 */
export class FatalError extends Error {
  readonly fatal = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FatalError";
  }
}

/**
 * A connection value that no request can carry, raised before anything is
 * sent: a header value with a line break in it, a URL that does not parse.
 * Core's `ctx.http` throws it; an integration never needs to.
 *
 * It is a verdict about the VALUES, not an outage and not a refusal by the
 * provider, which never saw the request: `readProviderFailure` reads it as a
 * refusal and core files it as `value_malformed`. `field` is the key of the
 * connection field the value came from, and the message names that field's
 * label and never repeats the value, because the value is usually a secret.
 */
export class ConnectionValueError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ConnectionValueError";
    this.field = field;
  }
}
