/**
 * The sentence a worker error body carries, or null when it carries none.
 *
 * The worker answers a refusal with a JSON body (`{ statusMessage, message }`
 * from h3, `{ error }` from a route that shapes its own), and that body is the
 * only place the full sentence survives: the HTTP reason phrase is sanitised
 * to visible ASCII by h3 and does not exist at all over HTTP/2.
 */
export function errorPayloadMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const body = payload as {
    error?: unknown;
    message?: unknown;
    statusMessage?: unknown;
  };

  return (
    stringValue(body.error) ??
    stringValue(body.message) ??
    stringValue(body.statusMessage)
  );
}

export function messageFromErrorPayload(payload: unknown): string {
  return errorPayloadMessage(payload) ?? "Request failed";
}

export async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("json")) {
    try {
      return messageFromErrorPayload(JSON.parse(text));
    } catch {
      return "Request failed";
    }
  }
  return text.trim() || res.statusText.trim() || "Request failed";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
