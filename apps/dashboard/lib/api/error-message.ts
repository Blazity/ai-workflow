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
  return messageFromErrorPayload(await res.json().catch(() => ({})));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
