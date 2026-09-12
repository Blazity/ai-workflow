import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { settings, settingsVersions } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {
    MCP_MAX_REQUEST_BYTES: 1_048_576,
    MCP_MAX_RESULT_BYTES: 524_288,
  } as Record<string, unknown>,
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));

const { SettingsValidationError, updateSettings } = await import("./store.js");

let db: Db;

function write(patch: Record<string, unknown>) {
  return updateSettings({ patch, actor: "user_admin", reason: "tuning MCP" });
}

async function storedNothing(): Promise<boolean> {
  const rows = await db.select().from(settings);
  const versions = await db.select().from(settingsVersions);
  return rows.length === 0 && versions.length === 0;
}

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
});

describe("settings store", () => {
  it("refuses a result limit raised above the request limit in force", async () => {
    // The environment schema refuses to boot on this pair, so storing it would
    // give the deployment a configuration it cannot start with.
    await expect(write({ MCP_MAX_RESULT_BYTES: 2_000_000 })).rejects.toThrow(
      SettingsValidationError,
    );
    await expect(write({ MCP_MAX_RESULT_BYTES: 2_000_000 })).rejects.toThrow(
      /MCP_MAX_RESULT_BYTES \(above_request_limit\)/,
    );
    expect(await storedNothing()).toBe(true);
  });

  it("refuses a request limit lowered below the result limit in force", async () => {
    await expect(write({ MCP_MAX_REQUEST_BYTES: 1_000 })).rejects.toThrow(
      /MCP_MAX_RESULT_BYTES \(above_request_limit\)/,
    );
    expect(await storedNothing()).toBe(true);
  });

  it("accepts the pair when both move together", async () => {
    const response = await write({
      MCP_MAX_REQUEST_BYTES: 2_000_000,
      MCP_MAX_RESULT_BYTES: 2_000_000,
    });
    expect(response.versions.map((version) => version.key).sort()).toEqual([
      "MCP_MAX_REQUEST_BYTES",
      "MCP_MAX_RESULT_BYTES",
    ]);

    // And the pair is judged against what is in force, not against the
    // environment: raising the result limit alone is fine once the stored
    // request limit is high enough.
    await expect(write({ MCP_MAX_RESULT_BYTES: 1_500_000 })).resolves.toMatchObject({
      versions: [{ key: "MCP_MAX_RESULT_BYTES", newValue: 1_500_000 }],
    });
  });

  it("leaves a patch that touches neither limit alone", async () => {
    await expect(write({ MAX_CONCURRENT_AGENTS: 5 })).resolves.toMatchObject({
      versions: [{ key: "MAX_CONCURRENT_AGENTS", newValue: 5 }],
    });
  });
});
