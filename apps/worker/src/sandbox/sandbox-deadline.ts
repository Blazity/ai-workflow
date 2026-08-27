/**
 * Bound on one sandbox API round trip made from inside a Workflow step.
 *
 * The @vercel/sandbox client has no timeout of its own (its undici dispatcher
 * even disables the body timeout so long log streams can flow), so a call
 * that never gets an answer holds the step's function invocation open until
 * the platform kills it at the deployed ceiling (maxDuration "max": 800 s on
 * Pro). Production hit exactly that on 2026-08-21 (run
 * wrun_01M0J1WX7HECNWK3J8G6SBH56X): one checkPhaseDone tick hung on the
 * sandbox, the queue redelivered the same step message after every kill, and
 * each redelivery hung again, so the run sat in RUNNING with a live claim
 * while nothing advanced. See docs/plans/2026-08-21-step-invocation-800s-incident.md.
 *
 * Sixty seconds is two poll ticks, far above a healthy round trip (hundreds
 * of milliseconds) and far below the 300 s default function limit, so a
 * deployment that does not raise maxDuration still answers before it is
 * killed. Keep it under whatever the deployed step function allows.
 */
export const SANDBOX_STEP_DEADLINE_MS = 60_000;

export class SandboxDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`Sandbox API call exceeded ${deadlineMs}ms`);
    this.name = "SandboxDeadlineError";
  }
}

/**
 * Runs `call` with an AbortSignal that fires after `deadlineMs`, and rejects
 * with SandboxDeadlineError at the same moment whether or not the callee
 * honours the signal. The race is the belt to the signal's braces: a client
 * that ignores `signal` still cannot keep the invocation alive.
 */
export async function withSandboxDeadline<T>(
  deadlineMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SandboxDeadlineError(deadlineMs);
      controller.abort(error);
      reject(error);
    }, deadlineMs);
  });
  try {
    return await Promise.race([call(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}
