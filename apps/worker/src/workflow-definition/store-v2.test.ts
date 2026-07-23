import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import type { Db } from "../db/client.js";

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

import { createTestDb } from "../db/test-db.js";
import {
  createWorkflowDefinition,
  deployWorkflowDefinition,
  getCurrentWorkflowDefinitionVersion,
  restoreWorkflowDefinitionVersion,
  rollbackWorkflowDefinition,
  saveWorkflowDefinitionDraft,
  type WorkflowDefinitionActor,
} from "./store.js";

const ADMIN: WorkflowDefinitionActor = { role: "admin", id: "u_admin", label: "Admin" };

function definitionV2(): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "ticket",
        type: "trigger_ticket_ai",
        x: 10,
        y: 20,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  };
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("v2 workflow definition storage", () => {
  it("saves and reads a v2 draft without rewriting its schema version", async () => {
    const created = await createWorkflowDefinition(db, {
      name: "V2 draft",
      seed: null,
      actor: ADMIN,
    });
    const saved = await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: definitionV2(),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });

    expect(saved.draft.schemaVersion).toBe(2);
    expect(saved.draftRevision).toBe(1);
    expect((await getCurrentWorkflowDefinitionVersion(db, created.definition.id))?.definition)
      .toMatchObject({ schemaVersion: 2 });
  });

  it("deploys and rolls back valid v2 versions", async () => {
    const created = await createWorkflowDefinition(db, {
      name: "V2 gated",
      seed: null,
      actor: ADMIN,
    });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: definitionV2(),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });

    const deployed = await deployWorkflowDefinition(db, {
      definitionId: created.definition.id,
      expectedDraftRevision: 1,
      expectedDeployedVersion: null,
      actor: ADMIN,
    });
    expect(deployed.version.version).toBe(1);
    expect(deployed.version.definition.schemaVersion).toBe(2);

    const rolledBack = await rollbackWorkflowDefinition(db, {
      definitionId: created.definition.id,
      version: 1,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });
    expect(rolledBack.version.version).toBe(1);
    expect(rolledBack.version.definition.schemaVersion).toBe(2);
  });

  it("restores a historical v2 version as a new draft", async () => {
    const created = await createWorkflowDefinition(db, {
      name: "V2 restore",
      seed: null,
      actor: ADMIN,
    });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: definitionV2(),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });

    const restored = await restoreWorkflowDefinitionVersion(db, {
      definitionId: created.definition.id,
      version: 1,
      actor: ADMIN,
    });

    expect(restored.version).toBe(2);
    expect(restored.restoredFromVersion).toBe(1);
    expect(restored.definition.schemaVersion).toBe(2);
  });
});
