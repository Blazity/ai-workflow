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

/**
 * A worker refusal as the browser may see it: the same status and body minus
 * the worker's own address.
 *
 * Nitro answers every h3 error with `{ error: true, url, statusCode,
 * statusMessage, message }`, and `url` is the worker's public URL. Route
 * handlers hand that body to the browser verbatim, so without this the one
 * address the dashboard exists to keep private was in every form's network
 * tab. The address is logged on the server instead, where an operator reading
 * a failure still finds which worker answered. Anything that is not Nitro's
 * error shape (a success, a stream, a body a route shaped itself) is returned
 * as it came.
 */
export async function withoutWorkerLocation(response: Response): Promise<Response> {
  if (response.ok || !response.headers.get("content-type")?.includes("json")) return response;
  const text = await response.text();
  const rebuilt = (body: string) =>
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: withoutLength(response.headers),
    });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rebuilt(text);
  }
  if (!isNitroError(body)) return rebuilt(text);
  const { url, ...visible } = body;
  console.error(
    `[worker] ${response.status} from ${String(url)}: ${errorPayloadMessage(body) ?? "no message"}`,
  );
  return rebuilt(JSON.stringify(visible));
}

function isNitroError(body: unknown): body is { url: unknown; [key: string]: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { error?: unknown }).error === true &&
    "url" in body
  );
}

/** The body is re-serialized, so the length it arrived with no longer holds. */
function withoutLength(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete("content-length");
  copy.delete("content-encoding");
  return copy;
}
