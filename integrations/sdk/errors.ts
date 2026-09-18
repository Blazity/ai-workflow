/**
 * A failure that retrying cannot fix: a refused credential, a resource that
 * does not exist, a request the provider rejects as invalid. Core never
 * retries a call that threw it. Any other error thrown by integration code may
 * be retried by core.
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
