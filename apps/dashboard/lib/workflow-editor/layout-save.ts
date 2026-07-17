export type LayoutSaveTask = () => Promise<boolean>;
export type LayoutSaveTimer = (callback: () => void, delayMs: number) => () => void;

export interface PendingLayoutSave {
  schedule(task: LayoutSaveTask): void;
  flush(): Promise<boolean>;
  discard(): void;
}

const defaultTimer: LayoutSaveTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createPendingLayoutSave(options?: {
  delayMs?: number;
  timer?: LayoutSaveTimer;
}): PendingLayoutSave {
  const delayMs = options?.delayMs ?? 500;
  const scheduleTimer = options?.timer ?? defaultTimer;
  let pending: LayoutSaveTask | null = null;
  let cancelTimer: (() => void) | null = null;
  let flushing: Promise<boolean> | null = null;

  function clearScheduledTimer() {
    cancelTimer?.();
    cancelTimer = null;
  }

  async function drain(): Promise<boolean> {
    clearScheduledTimer();
    while (pending) {
      const task = pending;
      pending = null;
      try {
        if (!(await task())) {
          pending ??= task;
          return false;
        }
      } catch (error) {
        pending ??= task;
        throw error;
      }
      clearScheduledTimer();
    }
    return true;
  }

  function flush(): Promise<boolean> {
    if (flushing) return flushing;
    const current = drain();
    flushing = current;
    current.then(
      () => {
        if (flushing === current) flushing = null;
      },
      () => {
        if (flushing === current) flushing = null;
      },
    );
    return current;
  }

  const controller: PendingLayoutSave = {
    schedule(task) {
      pending = task;
      clearScheduledTimer();
      cancelTimer = scheduleTimer(() => {
        cancelTimer = null;
        void flush().catch(() => undefined);
      }, delayMs);
    },
    flush,
    discard() {
      clearScheduledTimer();
      pending = null;
    },
  };

  return controller;
}

export async function afterPendingLayoutSave(
  pendingLayoutSave: Pick<PendingLayoutSave, "flush">,
  action: () => Promise<void>,
): Promise<boolean> {
  if (!(await pendingLayoutSave.flush())) return false;
  await action();
  return true;
}
