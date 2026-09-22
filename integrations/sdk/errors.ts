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
