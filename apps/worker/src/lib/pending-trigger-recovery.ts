import type { StoredTriggerDelivery } from "./trigger-delivery-store.js";

export interface PendingTriggerRecoveryDeps {
  listSubjects(): Promise<string[]>;
  getActive(subjectKey: string): Promise<unknown | null>;
  drain(subjectKey: string): Promise<{ result: string } | null>;
  onError?(subjectKey: string | null, error: unknown): void;
}

export interface PendingTriggerRecoveryMetrics {
  scanned: number;
  blocked: number;
  attempted: number;
  started: number;
  errors: number;
}

export interface AcceptedTriggerRecoveryDeps {
  listDeliveries(): Promise<StoredTriggerDelivery[]>;
  getActive(subjectKey: string): Promise<unknown | null>;
  resume(delivery: StoredTriggerDelivery): Promise<{ result: string } | null>;
  onError?(subjectKey: string | null, error: unknown): void;
}

/**
 * Poll-side recovery for the release-then-drain crash window. The active-owner
 * read is advisory only: drain still acquires the normal subject reservation,
 * so a concurrent successor wins safely and the pending row remains durable.
 */
export async function recoverOrphanedPendingTriggers(
  deps: PendingTriggerRecoveryDeps,
): Promise<PendingTriggerRecoveryMetrics> {
  const metrics: PendingTriggerRecoveryMetrics = {
    scanned: 0,
    blocked: 0,
    attempted: 0,
    started: 0,
    errors: 0,
  };
  let subjects: string[];
  try {
    subjects = await deps.listSubjects();
  } catch (error) {
    metrics.errors++;
    deps.onError?.(null, error);
    return metrics;
  }

  metrics.scanned = subjects.length;
  for (const subjectKey of subjects) {
    try {
      if (await deps.getActive(subjectKey)) {
        metrics.blocked++;
        continue;
      }
      metrics.attempted++;
      const result = await deps.drain(subjectKey);
      if (result?.result === "started") metrics.started++;
      if (result?.result === "error") metrics.errors++;
    } catch (error) {
      metrics.errors++;
      deps.onError?.(subjectKey, error);
    }
  }
  return metrics;
}

/**
 * Poll-side recovery for the acceptance-before-queue crash window. The active
 * read avoids needless work; resume re-reads the delivery and the dispatcher
 * still acquires the authoritative subject reservation.
 */
export async function recoverAcceptedTriggerDeliveries(
  deps: AcceptedTriggerRecoveryDeps,
): Promise<PendingTriggerRecoveryMetrics> {
  const metrics: PendingTriggerRecoveryMetrics = {
    scanned: 0,
    blocked: 0,
    attempted: 0,
    started: 0,
    errors: 0,
  };
  let deliveries: StoredTriggerDelivery[];
  try {
    deliveries = await deps.listDeliveries();
  } catch (error) {
    metrics.errors++;
    deps.onError?.(null, error);
    return metrics;
  }

  metrics.scanned = deliveries.length;
  for (const delivery of deliveries) {
    try {
      if (await deps.getActive(delivery.subjectKey)) {
        metrics.blocked++;
        continue;
      }
      metrics.attempted++;
      const result = await deps.resume(delivery);
      if (result?.result === "started") metrics.started++;
      if (result?.result === "error") metrics.errors++;
    } catch (error) {
      metrics.errors++;
      deps.onError?.(delivery.subjectKey, error);
    }
  }
  return metrics;
}
