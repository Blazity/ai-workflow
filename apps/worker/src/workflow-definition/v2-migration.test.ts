import { describe, expect, it, vi } from "vitest";

vi.mock("../../env.js", () => ({
  env: {
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-test",
    CODEX_MODEL: "codex-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
    GITHUB_APP_ID: 1,
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_INSTALLATION_ID: 2,
    GITLAB_TOKEN: "gitlab-token",
    CHAT_SDK_SLACK_TOKEN: "slack-token",
    CHAT_SDK_CHANNEL_ID: "channel",
    GENAI_ENGINE_API_KEY: "arthur-key",
    GENAI_ENGINE_TRACE_ENDPOINT: "https://arthur.example/traces",
  },
}));

import { inspectRawWorkflowDefinitionV1Migration } from "./v2-migration.js";

function rawDefinition(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
      { id: "finish", type: "terminate", x: 0, y: 0, params: { terminalStatus: "done" }, inputs: {} },
    ],
    edges: [{ from: "trigger", to: "finish" }],
    ...extra,
  };
}

describe("inspectRawWorkflowDefinitionV1Migration", () => {
  it("does not reject a stored definition carrying a pinned repository scope", () => {
    const preflight = inspectRawWorkflowDefinitionV1Migration(
      rawDefinition({
        repositoryScope: {
          repositories: [
            { provider: "github", repoPath: "Acme/Web" },
            { provider: "gitlab", repoPath: "acme/group/api" },
          ],
          providers: ["github", "gitlab"],
        },
      }),
    );

    expect(preflight.blockers).toEqual([]);
  });

  it("does not reject a stored definition that lacks a repository scope", () => {
    expect(inspectRawWorkflowDefinitionV1Migration(rawDefinition()).blockers).toEqual([]);
  });

  it("still rejects an unknown top-level field next to a repository scope", () => {
    const preflight = inspectRawWorkflowDefinitionV1Migration(
      rawDefinition({
        repositoryScope: { providers: ["github"] },
        repositoryPin: { providers: ["github"] },
      }),
    );

    expect(preflight.blockers).toEqual([
      expect.objectContaining({
        code: "migration.source.unknown_top_level_field",
        path: "/repositoryPin",
      }),
    ]);
  });
});
