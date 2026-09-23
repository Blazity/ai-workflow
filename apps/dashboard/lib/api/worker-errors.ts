/**
 * What can go wrong between the dashboard and the worker, told apart in one
 * place: the worker answering with a failure (`WorkerResponseError`,
 * `isWorkerStatus`) and our own wait running out before it answered
 * (`isWorkerTimeout`). Every route handler and data loader asks here rather
 * than keeping its own copy of the check.
 */
import { errorPayloadMessage } from "./error-message";

/**
 * A worker answer that was not a success, as `getJSON` throws it.
 *
 * The status and the body travel as fields rather than inside the message.
 * The worker writes its reason into the JSON body; the HTTP reason phrase that
 * used to be the only channel is sanitised to visible ASCII by h3 and does not
 * exist at all over HTTP/2, so a caller that parsed the message read an empty
 * reason in production. The message keeps its old shape for the log line it
 * ends up in.
 *
 * Its own module, free of `server-only`, so a test that replaces the transport
 * can still throw the real thing.
 */
export class WorkerResponseError extends Error {
  readonly path: string;
  readonly status: number;
  readonly statusText: string;
  /** The parsed JSON body, or null when the answer carried none. */
  readonly body: unknown;

  constructor(path: string, status: number, statusText: string, body: unknown) {
    super(`GET ${path} → ${status} ${statusText}`);
    this.name = "WorkerResponseError";
    this.path = path;
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }

  /** The worker's own sentence: the body first, the reason phrase last. */
  get reason(): string | null {
    return errorPayloadMessage(this.body) ?? (this.statusText.trim() || null);
  }
}

/**
 * Whether a thrown value is our own wait running out, rather than the worker
 * answering. `AbortSignal.timeout` rejects a fetch with a `TimeoutError`;
 * `code` 23 is the same error from a runtime that still numbers them.
 */
export function isWorkerTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.name === "TimeoutError" || candidate.code === 23;
}

/** Whether a thrown value is the worker answering with this status. */
export function isWorkerStatus(error: unknown, ...statuses: number[]): error is WorkerResponseError {
  return error instanceof WorkerResponseError && statuses.includes(error.status);
}
