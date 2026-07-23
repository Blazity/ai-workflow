export const REPLAY_CAPTURE_TIMEOUT_MS = 2_000;

export async function replayCaptureWithinTimeout<T>(
  operation: Promise<T>,
  timeoutMs = REPLAY_CAPTURE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Replay capture timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
