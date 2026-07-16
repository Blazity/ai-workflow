import { defineEventHandler, setResponseHeader } from "h3";
import { env } from "../../../../../env.js";
import { getDb } from "../../../../db/client.js";
import { createAdapters } from "../../../../lib/adapters.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import { collectLiveRuns } from "../../../../lib/overview/collect-live-runs.js";
import { collectAwaitingRuns } from "../../../../lib/overview/collect-awaiting-store.js";
import type { LiveRunsResponse } from "@shared/contracts";

export default defineEventHandler(
  async (event): Promise<LiveRunsResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");

    try {
      // Guarded: the awaiting rows carry the parked runs' question texts.
      await requireDashboardActor(event);

      const adapters = createAdapters();
      const model =
        env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

      const now = new Date();
      const [running, awaiting] = await Promise.all([
        collectLiveRuns({
          registry: adapters.runRegistry,
          issueTracker: adapters.issueTracker,
          jiraBaseUrl: env.JIRA_BASE_URL,
          model,
        }),
        collectAwaitingRuns({
          db: getDb(),
          jiraBaseUrl: env.JIRA_BASE_URL,
          model,
          now,
        }),
      ]);

      // A parked run keeps its run-registry entry, so collectLiveRuns still reports
      // it "running". The store-backed awaiting row (same real run id, with the
      // question payload) is the truth, so drop the running duplicate: an orphaned
      // registry entry must not mask a parked run.
      const awaitingIds = new Set(awaiting.map((r) => r.id));
      const runningOnly = running.filter((r) => !awaitingIds.has(r.id));

      return {
        generatedAt: now.toISOString(),
        rows: [...runningOnly, ...awaiting],
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
