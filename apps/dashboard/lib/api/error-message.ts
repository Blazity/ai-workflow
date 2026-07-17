export function messageFromErrorPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Request failed";

  const body = payload as {
    error?: unknown;
    message?: unknown;
    statusMessage?: unknown;
  };

  return (
    stringValue(body.error) ??
    stringValue(body.message) ??
    stringValue(body.statusMessage) ??
    "Request failed"
  );
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
