import "server-only";

import { authAwareFallback, getJSON } from "@/lib/api/server";
import type { IntegrationPageData } from "@integrations/registry/dashboard";

/**
 * What one contributed page is handed, read through that integration's own
 * worker entry.
 *
 * The cockpit waits for this rather than letting a page fetch for itself: a
 * page that never answers would be a tab that never finishes, and nothing on
 * our side could cancel it. The worker bounds the call; this bounds nothing
 * more and turns every way of not having data into the three the contract
 * names, so a page never has to guess whether silence was an outage or an
 * empty provider.
 */
type WorkerPageData =
  | { status: "ok"; value: unknown }
  | { status: "unknown" }
  | { status: "none" }
  | { status: "unavailable"; cause?: "not_connected" | "provider"; reason: string };

export async function readContributedPageData(
  integrationId: string,
  pageId: string,
): Promise<IntegrationPageData> {
  const answer = await getJSON<WorkerPageData>(
    `/api/v1/integrations/${encodeURIComponent(integrationId)}/pages/${encodeURIComponent(pageId)}`,
  ).catch((error) => authAwareFallback(error, (): WorkerPageData | null => null));

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
