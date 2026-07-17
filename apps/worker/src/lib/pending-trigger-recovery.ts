export interface PendingTriggerRecoveryDeps {
  listSubjects(): Promise<string[]>;
  getActive(subjectKey: string): Promise<unknown | null>;
  drain(subjectKey: string): Promise<{ result: string } | null>;
  onError?(subjectKey: string | null, error: unknown): void;
}

/**
 * Poll-side recovery for the release-then-drain crash window. The active-owner
 * read is advisory only: drain still acquires the normal subject reservation,
 * so a concurrent successor wins safely and the pending row remains durable.
 */
export async function recoverOrphanedPendingTriggers(
  deps: PendingTriggerRecoveryDeps,
): Promise<number> {
  let subjects: string[];
  try {
    subjects = await deps.listSubjects();
  } catch (error) {
    deps.onError?.(null, error);
    return 0;
  }

  let recovered = 0;
  for (const subjectKey of subjects) {
    try {
      if (await deps.getActive(subjectKey)) continue;
      const result = await deps.drain(subjectKey);
      if (result?.result === "started") recovered++;
    } catch (error) {
      deps.onError?.(subjectKey, error);
    }
  }
  return recovered;
}
