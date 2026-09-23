/**
 * A ticket link through the real chain, from a Jira connection to a run read.
 *
 * Every other link test hands core a fake `ticketUrl`. This one does not: the
 * real Jira manifest and runtime, resolved by the real reader (so behind
 * `redactingRuntime`), handed out by the real tracker resolution (so behind
 * `redactingPublications`), read by `issueTrackerTicketLinks`, and rendered by
 * the run read the dashboard and MCP use. A wrapper that dropped `ticketUrl`,
 * or turned it into something other than a string, shows up here as a run
 * with no link, or with the link core used to spell itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { workflowRuns } from "../../db/schema.js";

vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));
// Nothing stored in the database: the connection comes from the environment,
// as a deployment configured before the Integrations page has it.
vi.mock("../../db/repositories/integrations.js", () => ({
  readConnectedIntegrationConnections: async () => new Map(),
}));

const { issueTrackerTicketLinks } = await import("./integration-settings.js");
const { fetchRunDetailFromDb } = await import("../run-lifecycle/durable-run-detail.js");

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  // The Site URL saved with a path, which is where core's own spelling broke.
  vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net/jira");
  vi.stubEnv("JIRA_API_TOKEN", "jira-token-value");
  vi.stubEnv("JIRA_PROJECT_KEY", "AWT");
});

describe("a ticket link from a real Jira connection to a run read", () => {
  it("is the page Jira serves, on the site's origin, for a run that recorded none", async () => {
    await db.insert(workflowRuns).values({
      runId: "r-chain",
      status: "running",
      ticketKey: "AWT-5",
      startedAt: new Date("2026-09-23T10:00:00Z"),
    });

    const ticketLinks = await issueTrackerTicketLinks();
    const read = await fetchRunDetailFromDb({ db, runId: "r-chain", ticketLinks, secrets: [] });

    expect(read?.run.ticketUrl).toBe("https://acme.atlassian.net/browse/AWT-5");
  });

  it("repairs a link core once spelled from the Site URL's path", async () => {
    await db.insert(workflowRuns).values({
      runId: "r-old",
      status: "success",
      ticketKey: "AWT-6",
      ticketUrl: "https://acme.atlassian.net/jira/browse/AWT-6",
      startedAt: new Date("2026-09-20T10:00:00Z"),
    });

    const ticketLinks = await issueTrackerTicketLinks();
    const read = await fetchRunDetailFromDb({ db, runId: "r-old", ticketLinks, secrets: [] });

    expect(read?.run.ticketUrl).toBe("https://acme.atlassian.net/browse/AWT-6");
  });
});
