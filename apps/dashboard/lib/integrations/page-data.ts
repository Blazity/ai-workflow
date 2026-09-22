import "server-only";

import { authAwareFallback, getJSON } from "@/lib/api/server";
import { isWorkerTimeout } from "@/lib/api/worker-response-error";
import { PROVIDER_CALL_CEILING_MS } from "@/lib/integrations/provider-wait";
import type { IntegrationPageData } from "@integrations/registry/dashboard";

/**
 * What one contributed page is handed, read through that integration's own
 * worker entry.
 *
 * The cockpit waits for this rather than letting a page fetch for itself: a
 * page that never answers would be a tab that never finishes, and nothing on
 * our side could cancel it. The worker bounds the provider call with the
 * shared budget, and this waits longer than that budget, so a provider that is
 * slow but answers reaches the page, and one that does not is reported by the
 * worker as the provider's failure rather than by us as our own outage. Every
 * way of not having data becomes one of the three the contract names, so a
 * page never has to guess whether silence was an outage or an empty provider.
 */
type WorkerPageData =
  | { status: "ok"; value: unknown }
  | { status: "unknown" }
  | { status: "none" }
  | { status: "unavailable"; cause?: "not_connected" | "provider"; reason: string };

/** Our own wait ran out: the worker did not answer inside its own budget. */
const TIMED_OUT = "timed_out" as const;

export async function readContributedPageData(
  integrationId: string,
  pageId: string,
): Promise<IntegrationPageData> {
  const answer = await getJSON<WorkerPageData>(
    `/api/v1/integrations/${encodeURIComponent(integrationId)}/pages/${encodeURIComponent(pageId)}`,
    { timeoutMs: PROVIDER_CALL_CEILING_MS },
  ).catch((error) =>
    authAwareFallback(error, (): WorkerPageData | typeof TIMED_OUT | null =>
      isWorkerTimeout(error) ? TIMED_OUT : null,
    ),
  );

  if (answer === TIMED_OUT) {
    // The worker promised an answer, the provider's or its own refusal, well
    // inside this wait. Not getting one is ours, whatever the provider did.
    return {
      status: "unavailable",
      cause: "worker",
      reason: `The worker did not answer within ${PROVIDER_CALL_CEILING_MS / 1000} seconds, so this page has not been read.`,
    };
  }
  if (!answer) {
    return {
      status: "unavailable",
      cause: "worker",
      reason: "The worker did not answer, so this page has not been read yet.",
    };
  }
  if (answer.status === "ok") return { status: "ok", value: answer.value };
  if (answer.status === "unavailable") {
    // A worker one deploy behind names no cause; what it reported is the
    // provider's answer or the connection's, and the connection says which.
    return { status: "unavailable", cause: answer.cause ?? "provider", reason: answer.reason };
  }
  // "unknown" means this build ships no such page, which the area has already
  // said in its own words; the page still renders, with nothing of ours in it.
  return { status: "none" };
}
