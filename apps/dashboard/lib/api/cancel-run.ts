// apps/dashboard/lib/api/cancel-run.ts
import type { RunCancelResponse } from "@shared/contracts";

/**
 * Result of a run-cancel POST, collapsed from the HTTP status and the typed
 * `RunCancelResponse` body into one union the UI switches on.
 *
 * Decided by the response body's `outcome`, never by `res.ok` alone: a 200
 * can carry "already_terminal", which is NOT a fresh cancel (see the E4
 * security review referenced by AIW-240). 403/404 carry no typed body (h3
 * error JSON), so those are read straight off the status.
 */
export type CancelRunResult =
  | { outcome: "cancelled" }
  | { outcome: "already_terminal" }
  | { outcome: "unconfirmed" }
  | { outcome: "forbidden" }
  | { outcome: "not_found" }
  | { outcome: "error" };

/** POSTs the dashboard's cancel proxy for one run and decodes the result. */
export async function cancelRun(runId: string): Promise<CancelRunResult> {
  let res: Response;
  try {
    res = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });
  } catch {
    return { outcome: "error" };
  }
  if (res.status === 403) return { outcome: "forbidden" };
  if (res.status === 404) return { outcome: "not_found" };
  // 200 and 409 are the only statuses that carry a typed RunCancelResponse
  // body; anything else (500, 504, ...) is a generic failure.
  if (res.status !== 200 && res.status !== 409) return { outcome: "error" };
  try {
    const body = (await res.json()) as RunCancelResponse;
    if (
      body.outcome === "cancelled" ||
      body.outcome === "already_terminal" ||
      body.outcome === "unconfirmed"
    ) {
      return { outcome: body.outcome };
    }
    return { outcome: "error" };
  } catch {
    return { outcome: "error" };
  }
}
