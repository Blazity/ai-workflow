export class WaitTimeoutError extends Error {
  constructor(description: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
    this.name = "WaitTimeoutError";
  }
}

export async function waitFor<T>(
  fn: () => Promise<T | null | false | undefined>,
  opts: { description: string; timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const { description, timeoutMs, intervalMs = 5_000 } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new WaitTimeoutError(description, timeoutMs);
}
