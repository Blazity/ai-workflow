export type LayoutSaveTask = (expectedLayoutRevision: number) => Promise<number | false>;
export type LayoutSaveTimer = (callback: () => void, delayMs: number) => () => void;

export interface PendingLayoutSave {
  schedule(task: LayoutSaveTask): void;
  flush(): Promise<boolean>;
  discard(): void;
  invalidateAndWait(): Promise<void>;
  reset(layoutRevision: number): void;
}

const defaultTimer: LayoutSaveTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createPendingLayoutSave(options?: {
  delayMs?: number;
  timer?: LayoutSaveTimer;
  initialLayoutRevision?: number;
}): PendingLayoutSave {
  const delayMs = options?.delayMs ?? 500;
  const scheduleTimer = options?.timer ?? defaultTimer;
  let pending: LayoutSaveTask | null = null;
  let cancelTimer: (() => void) | null = null;
  let flushing: Promise<boolean> | null = null;
  let layoutRevision = options?.initialLayoutRevision ?? 0;
  let generation = 0;

  function clearScheduledTimer() {
    cancelTimer?.();
    cancelTimer = null;
  }

  async function drain(): Promise<boolean> {
    clearScheduledTimer();
    while (pending) {
      const task = pending;
      const taskGeneration = generation;
      pending = null;
      try {
        const savedRevision = await task(layoutRevision);
        if (taskGeneration !== generation) return true;
        if (savedRevision === false) {
          pending ??= task;
          return false;
        }
        layoutRevision = savedRevision;
      } catch (error) {
        if (taskGeneration !== generation) return true;
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
    async invalidateAndWait() {
      generation += 1;
      clearScheduledTimer();
      pending = null;
      await flushing?.catch(() => undefined);
    },
    reset(revision) {
      layoutRevision = revision;
    },
  };

  return controller;
}

export async function afterInvalidatingLayoutSave(
  pendingLayoutSave: Pick<PendingLayoutSave, "invalidateAndWait">,
  action: () => Promise<void>,
): Promise<void> {
  await pendingLayoutSave.invalidateAndWait();
  await action();
}

export async function afterPendingLayoutSave(
  pendingLayoutSave: Pick<PendingLayoutSave, "flush">,
  action: () => Promise<void>,
): Promise<boolean> {
  if (!(await pendingLayoutSave.flush())) return false;
  await action();
  return true;
}
