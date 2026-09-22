import { defineIntegration } from "@integrations/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

/**
 * The secrets this deployment knows, read the way production reads them: a
 * connection is saved through the same service the Integrations page calls,
 * sealed with the deployment's key, and never written to the environment.
 *
 * Two integrations, because the snapshot scan asks for a narrower set than the
 * redaction does, and the narrowing is only visible with something to leave
 * out.
 */
const tracing = defineIntegration({
  id: "tracer",
  name: "Tracer",
  description: "Hands a key to every agent sandbox.",
  connection: {
    fields: [{ key: "apiKey", label: "API key", env: "TRACER_API_KEY", secret: true }],
  },
  capabilities: ["agent_tracing"],
  blocks: [],
  pages: [],
  health: [],
});
const tracker = defineIntegration({
  id: "tracker",
  name: "Tracker",
  description: "Never enters a sandbox.",
  connection: {
    fields: [{ key: "apiToken", label: "API token", env: "TRACKER_API_TOKEN", secret: true }],
  },
  capabilities: ["issue_tracker"],
  blocks: [],
  pages: [],
  health: [],
});

/** The database the deployment reads, or none at all while `databaseDown`. */
vi.mock("../../db/client.js", () => ({
  getDb: () => {
    if (databaseDown) throw new Error("database unreachable");
    if (blinks > 0) {
      blinks -= 1;
      throw new Error("connection reset");
    }
    return db;
  },
}));
vi.mock("@integrations/registry", () => ({
  integrationManifests: [tracing, tracker],
  integrationManifest: (id: string) => [tracing, tracker].find((entry) => entry.id === id),
}));
vi.mock("@integrations/registry/worker", () => ({
  integrationRuntime: (id: string) => {
    const manifest = [tracing, tracker].find((entry) => entry.id === id);
    return manifest
      ? { manifest, testConnection: async () => ({ ok: true as const, message: "reachable" }) }
      : undefined;
  },
}));

const { saveIntegrationConnection } = await import("./authoring.js");
const { IntegrationSecretsUnreadableError, integrationSecretValues, knownSecretValues } =
  await import("./secret-values.js");

/** Shaped like nothing a pattern would catch: only redaction by value finds it. */
const STORED_TRACER_KEY = "plainvalue4471tracer";
const STORED_TRACKER_TOKEN = "plainvalue9902tracker";

let db: Db;
let databaseDown = false;
/** How many reads fail before the database answers again. */
let blinks = 0;
const originalEnv = { ...process.env };

beforeEach(async () => {
  db = await createTestDb();
  await db.execute("insert into env_marker (id, env, endpoint_host) values (1, 'development', 'local')");
  process.env.INTEGRATION_SECRETS_KEY = "d".repeat(64);
  delete process.env.TRACER_API_KEY;
  delete process.env.TRACKER_API_TOKEN;
  databaseDown = false;
  blinks = 0;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

async function store(
  integrationId: string,
  key: string,
  value: string,
  expectedVersion = 0,
): Promise<void> {
  const result = await saveIntegrationConnection({
    actor: { role: "admin", id: "user-1" },
    integrationId,
    expectedVersion,
    values: { [key]: value },
    clearSecrets: [],
  });
  expect(result.integration.state.status).toBe("connected");
}

describe("the secrets this deployment knows", () => {
  // Red when: the set is built from the environment alone, which is how a token
  // an admin pasted into the Integrations page reached run logs, replays and
  // ticket comments in the clear.
  it("holds a secret an admin stored in the dashboard, which no environment variable carries", async () => {
    await store("tracker", "apiToken", STORED_TRACKER_TOKEN);
    expect(Object.values(process.env)).not.toContain(STORED_TRACKER_TOKEN);

    expect(await knownSecretValues()).toContain(STORED_TRACKER_TOKEN);
  });

  it("holds the environment's secrets beside the stored ones", async () => {
    await store("tracker", "apiToken", STORED_TRACKER_TOKEN);
    process.env.SOME_PLATFORM_API_KEY = "platform-key-value-123";

    expect(await knownSecretValues()).toEqual(
      expect.arrayContaining([STORED_TRACKER_TOKEN, "platform-key-value-123"]),
    );
  });

  // Red when: a database that cannot be read answers with the environment half
  // as if it were the whole set. Every caller is about to write or publish, and
  // a smaller set there is a stored secret written in the clear.
  it("refuses, rather than answering with part of the set, when the settings cannot be read", async () => {
    await store("tracker", "apiToken", STORED_TRACKER_TOKEN);
    databaseDown = true;

    await expect(knownSecretValues()).rejects.toBeInstanceOf(IntegrationSecretsUnreadableError);
  });

  // Red when: the snapshot scan's narrower ask returns every integration's
  // secret. Its patterns are written into the sandbox, so a token that was never
  // handed to the sandbox would be handed to it by the scan itself.
  it("narrows to the integrations a caller names, for the scan that writes into a sandbox", async () => {
    await store("tracer", "apiKey", STORED_TRACER_KEY);
    await store("tracker", "apiToken", STORED_TRACKER_TOKEN);

    const tracingOnly = await integrationSecretValues({
      include: (manifest) => manifest.capabilities.includes("agent_tracing"),
    });
    expect(tracingOnly).toEqual([STORED_TRACER_KEY]);
  });

  // Red when: the set holds only the active version. Runs in flight still carry
  // the key they started with in their sandboxes, so a rotation mid-run printed
  // the old key in the clear in their logs, replays and publications.
  it("keeps a rotated key in the set, since runs started with it still hold it", async () => {
    await store("tracer", "apiKey", STORED_TRACER_KEY);
    await store("tracer", "apiKey", "plainvalue5520rotated", 1);

    expect(await knownSecretValues()).toEqual(
      expect.arrayContaining([STORED_TRACER_KEY, "plainvalue5520rotated"]),
    );
  });

  it("forgets the stored keys once a disconnect has erased them", async () => {
    await store("tracer", "apiKey", STORED_TRACER_KEY);
    const { disconnectIntegration } = await import("../../db/repositories/integrations.js");
    await disconnectIntegration(db, { integrationId: "tracer", actorId: "user-1" });

    expect(await knownSecretValues()).not.toContain(STORED_TRACER_KEY);
  });

  // Red when: the source reads the connection tables twice (once for the
  // states, once for the values), which is two round trips on every hot path
  // and two moments a save can land between.
  it("reads the connection tables in one statement", async () => {
    await store("tracer", "apiKey", STORED_TRACER_KEY);
    const execute = vi.spyOn(db, "execute");

    await knownSecretValues();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rides out a database blink instead of failing the caller", async () => {
    await store("tracer", "apiKey", STORED_TRACER_KEY);
    blinks = 1;

    expect(await knownSecretValues()).toContain(STORED_TRACER_KEY);
  });

  it("refuses with a sentence that carries none of the database's words", async () => {
    databaseDown = true;

    const refusal = await knownSecretValues().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(IntegrationSecretsUnreadableError);
    expect((refusal as Error).message).not.toContain("unreachable");
    expect(((refusal as Error).cause as Error).message).toBe("database unreachable");
  });
});
