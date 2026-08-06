import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { webhookTriggerEndpoints } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  WebhookSecretDecryptionError,
  WebhookSecretKeyMismatchError,
} from "../lib/webhook-crypto.js";
import {
  decryptCandidateSecrets,
  getWebhookEndpointById,
  getWebhookEndpointForNode,
  mintWebhookEndpointsForDefinition,
  revealWebhookEndpointSecret,
  revokeWebhookEndpoint,
  rotateWebhookEndpointSecret,
  setWebhookEndpointSecret,
  unrevokeWebhookEndpoint,
  WebhookRotationInFlightError,
  WebhookSecretInvalidError,
  type MintableWebhookNode,
} from "./endpoint-store.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
/** The definition the 0013 migration seeds. */
const DEFINITION_ID = 1;

function webhookNode(
  id: string,
  configuration: Record<string, unknown> = {},
): MintableWebhookNode {
  return { id, type: "trigger_webhook", configuration };
}

async function allEndpoints(db: Db) {
  return db.select().from(webhookTriggerEndpoints);
}

async function mintOne(db: Db, node = webhookNode("hook")) {
  const [minted] = await mintWebhookEndpointsForDefinition(db, KEY, {
    definitionId: DEFINITION_ID,
    nodes: [node],
  });
  return minted!;
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("mintWebhookEndpointsForDefinition", () => {
  it("mints one endpoint per webhook node and returns each secret once", async () => {
    const minted = await mintWebhookEndpointsForDefinition(db, KEY, {
      definitionId: DEFINITION_ID,
      nodes: [
        webhookNode("hook_a"),
        { id: "agent", type: "planning_agent" },
        webhookNode("hook_b"),
      ],
    });

    expect(minted.map((entry) => entry.nodeId)).toEqual(["hook_a", "hook_b"]);
    expect(minted.every((entry) => entry.minted)).toBe(true);
    expect(minted.every((entry) => entry.secret?.startsWith("whsec_"))).toBe(true);
    expect(minted[0]!.endpointId).toMatch(/^wh_[0-9a-f]{24}$/);
    expect(minted[0]!.endpointId).not.toBe(minted[1]!.endpointId);

    const rows = await allEndpoints(db);
    expect(rows).toHaveLength(2);
    // The cleartext secret is nowhere in the row.
    for (const row of rows) {
      expect(row.secretCiphertext).toMatch(/^v1:[0-9a-f]{8}:/);
      expect(JSON.stringify(row)).not.toContain("whsec_");
    }
  });

  it("stores the authored auth scheme and header name, defaulting both", async () => {
    await mintWebhookEndpointsForDefinition(db, KEY, {
      definitionId: DEFINITION_ID,
      nodes: [
        webhookNode("hook_default"),
        webhookNode("hook_token", {
          authScheme: "shared_token",
          headerName: "  X-Zendesk-Token  ",
        }),
      ],
    });

    const defaulted = await getWebhookEndpointForNode(db, DEFINITION_ID, "hook_default");
    expect(defaulted).toMatchObject({ authScheme: "hmac_sha256", headerName: null });
    const authored = await getWebhookEndpointForNode(db, DEFINITION_ID, "hook_token");
    expect(authored).toMatchObject({
      authScheme: "shared_token",
      headerName: "X-Zendesk-Token",
    });
  });

  it("stores the timestamp replay config, defaulting the flag off and tolerance to 300", async () => {
    await mintWebhookEndpointsForDefinition(db, KEY, {
      definitionId: DEFINITION_ID,
      nodes: [
        webhookNode("hook_default"),
        webhookNode("hook_ts", {
          requireTimestamp: true,
          timestampHeader: "  X-Zendesk-Timestamp  ",
          timestampToleranceSeconds: 600,
        }),
      ],
    });

    const defaulted = await getWebhookEndpointForNode(db, DEFINITION_ID, "hook_default");
    expect(defaulted).toMatchObject({
      requireTimestamp: false,
      timestampHeader: null,
      timestampToleranceSeconds: 300,
    });
    const configured = await getWebhookEndpointForNode(db, DEFINITION_ID, "hook_ts");
    expect(configured).toMatchObject({
      requireTimestamp: true,
      timestampHeader: "X-Zendesk-Timestamp",
      timestampToleranceSeconds: 600,
    });
  });

  it("re-syncs the timestamp flag off and the tolerance back to default on redeploy", async () => {
    const first = await mintOne(
      db,
      webhookNode("hook", {
        requireTimestamp: true,
        timestampHeader: "X-Zendesk-Timestamp",
        timestampToleranceSeconds: 600,
      }),
    );
    const before = (await getWebhookEndpointById(db, first.endpointId))!;
    expect(before).toMatchObject({
      requireTimestamp: true,
      timestampHeader: "X-Zendesk-Timestamp",
      timestampToleranceSeconds: 600,
    });

    // The operator cleared replay protection in the draft and redeployed: every
    // value re-syncs from the now-empty config, exactly like headerName does.
    await mintOne(db, webhookNode("hook"));

    const after = (await getWebhookEndpointById(db, first.endpointId))!;
    expect(after).toMatchObject({
      requireTimestamp: false,
      timestampHeader: null,
      timestampToleranceSeconds: 300,
    });
    // A re-deploy never touches the secret.
    expect(after.secretCiphertext).toBe(before.secretCiphertext);
    expect(await revealWebhookEndpointSecret(db, KEY, first.endpointId)).toBe(first.secret);
  });

  it("filters an out-of-range tolerance to the default so the row never stores 0", async () => {
    for (const [nodeId, tolerance] of [
      ["hook_low", 5],
      // Above the 900s ceiling (but under the old 86400) so this pins the
      // tightened bound, not just an absurd value.
      ["hook_high", 1000],
      ["hook_zero", 0],
    ] as const) {
      await mintOne(
        db,
        webhookNode(nodeId, {
          requireTimestamp: true,
          timestampToleranceSeconds: tolerance,
        }),
      );
      const row = await getWebhookEndpointForNode(db, DEFINITION_ID, nodeId);
      // Filtered to the column default, never the out-of-range value (0 would
      // also trip the tolerance CHECK, so this proves the filter runs first).
      expect(row!.timestampToleranceSeconds, String(tolerance)).toBe(300);
    }
  });

  it("re-syncs the authored scheme on redeploy but re-mints no secret", async () => {
    const first = await mintOne(db, webhookNode("hook", { authScheme: "shared_token" }));
    const before = (await getWebhookEndpointById(db, first.endpointId))!;

    // A re-deploy that changed the authored scheme: it is a draft -> deploy
    // config like any other param, so the new scheme lands on the row while the
    // secret and its ciphertext survive untouched.
    const second = await mintWebhookEndpointsForDefinition(db, KEY, {
      definitionId: DEFINITION_ID,
      nodes: [webhookNode("hook", { authScheme: "hmac_sha256", headerName: "X-Redeployed" })],
    });

    expect(second).toEqual([
      { endpointId: first.endpointId, nodeId: "hook", minted: false, secret: null },
    ]);
    expect(await allEndpoints(db)).toHaveLength(1);
    const after = (await getWebhookEndpointById(db, first.endpointId))!;
    expect(after.secretCiphertext).toBe(before.secretCiphertext);
    expect(after.authScheme).toBe("hmac_sha256");
    expect(after.headerName).toBe("X-Redeployed");
    expect(await revealWebhookEndpointSecret(db, KEY, first.endpointId)).toBe(first.secret);
  });

  it("leaves a revoked endpoint revoked when its node is deployed again", async () => {
    const first = await mintOne(db);
    await revokeWebhookEndpoint(db, first.endpointId);
    const revokedAt = (await getWebhookEndpointById(db, first.endpointId))!.revokedAt;
    expect(revokedAt).not.toBeNull();

    const second = await mintOne(db);

    expect(second).toMatchObject({ endpointId: first.endpointId, minted: false, secret: null });
    // A deploy is not an operator decision to trust this endpoint again.
    expect((await getWebhookEndpointById(db, first.endpointId))!.revokedAt).toEqual(revokedAt);
  });

  it("does nothing without an encryption key", async () => {
    const minted = await mintWebhookEndpointsForDefinition(db, undefined, {
      definitionId: DEFINITION_ID,
      nodes: [webhookNode("hook")],
    });

    expect(minted).toEqual([]);
    expect(await allEndpoints(db)).toHaveLength(0);
  });
});

describe("endpoint reads", () => {
  it("resolves an endpoint by id and by node, and returns null otherwise", async () => {
    const minted = await mintOne(db);

    expect((await getWebhookEndpointById(db, minted.endpointId))!.nodeId).toBe("hook");
    expect((await getWebhookEndpointForNode(db, DEFINITION_ID, "hook"))!.id).toBe(
      minted.endpointId,
    );
    expect(await getWebhookEndpointById(db, "wh_missing")).toBeNull();
    expect(await getWebhookEndpointForNode(db, DEFINITION_ID, "other")).toBeNull();
  });

  it("still resolves a revoked endpoint so the caller can say why it refused", async () => {
    const minted = await mintOne(db);
    await revokeWebhookEndpoint(db, minted.endpointId);

    const row = await getWebhookEndpointById(db, minted.endpointId);
    expect(row).not.toBeNull();
    expect(row!.revokedAt).toBeInstanceOf(Date);
  });

  it("keeps the first revocation instant when revoked twice", async () => {
    const minted = await mintOne(db);
    await revokeWebhookEndpoint(db, minted.endpointId);
    const first = (await getWebhookEndpointById(db, minted.endpointId))!.revokedAt;

    await revokeWebhookEndpoint(db, minted.endpointId);

    expect((await getWebhookEndpointById(db, minted.endpointId))!.revokedAt).toEqual(first);
  });
});

describe("unrevokeWebhookEndpoint", () => {
  it("revives an endpoint on a fresh secret, killing the revoked one outright", async () => {
    const minted = await mintOne(db);
    await revokeWebhookEndpoint(db, minted.endpointId);

    const revived = (await unrevokeWebhookEndpoint(db, KEY, minted.endpointId))!;

    expect(revived.endpointId).toBe(minted.endpointId);
    expect(revived.secret).not.toBe(minted.secret);
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(row.revokedAt).toBeNull();
    expect(await revealWebhookEndpointSecret(db, KEY, minted.endpointId)).toBe(revived.secret);
    // No dual-accept window on this path: the revoked secret is presumed leaked,
    // so a delivery signed with it is refused from the instant of the revival.
    expect(row.previousSecretCiphertext).toBeNull();
    expect(row.previousExpiresAt).toBeNull();
    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: revived.secret, verifiedWith: "current" },
    ]);
  });

  it("closes a rotation window that was still open at revocation", async () => {
    const minted = await mintOne(db);
    await rotateWebhookEndpointSecret(db, KEY, minted.endpointId);
    await revokeWebhookEndpoint(db, minted.endpointId);

    const revived = (await unrevokeWebhookEndpoint(db, KEY, minted.endpointId))!;

    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: revived.secret, verifiedWith: "current" },
    ]);
  });

  it("returns null for an unknown endpoint", async () => {
    expect(await unrevokeWebhookEndpoint(db, KEY, "wh_missing")).toBeNull();
  });

  it("returns null for a live endpoint, leaving its secret untouched", async () => {
    const minted = await mintOne(db);

    // The revival only touches a still-revoked row, so a live one is a no-op.
    expect(await unrevokeWebhookEndpoint(db, KEY, minted.endpointId)).toBeNull();
    expect(await revealWebhookEndpointSecret(db, KEY, minted.endpointId)).toBe(minted.secret);
  });
});

describe("rotateWebhookEndpointSecret", () => {
  it("opens a 24 hour window in which both secrets are accepted", async () => {
    const minted = await mintOne(db);

    const rotated = (await rotateWebhookEndpointSecret(db, KEY, minted.endpointId))!;

    expect(rotated.endpointId).toBe(minted.endpointId);
    expect(rotated.secret).not.toBe(minted.secret);
    const expectedExpiry = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(rotated.previousExpiresAt.getTime() - expectedExpiry)).toBeLessThan(
      60_000,
    );
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: rotated.secret, verifiedWith: "current" },
      { secret: minted.secret, verifiedWith: "previous" },
    ]);
  });

  it("refuses a second rotation while the window is open, without evicting anything", async () => {
    const minted = await mintOne(db);
    const rotated = (await rotateWebhookEndpointSecret(db, KEY, minted.endpointId))!;

    await expect(
      rotateWebhookEndpointSecret(db, KEY, minted.endpointId),
    ).rejects.toBeInstanceOf(WebhookRotationInFlightError);

    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: rotated.secret, verifiedWith: "current" },
      { secret: minted.secret, verifiedWith: "previous" },
    ]);
  });

  it("rotates through an open window when forced, evicting the original secret", async () => {
    const minted = await mintOne(db);
    const rotated = (await rotateWebhookEndpointSecret(db, KEY, minted.endpointId))!;

    const forced = (await rotateWebhookEndpointSecret(db, KEY, minted.endpointId, {
      force: true,
    }))!;

    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: forced.secret, verifiedWith: "current" },
      { secret: rotated.secret, verifiedWith: "previous" },
    ]);
  });

  it("rotates again once the window has closed", async () => {
    const minted = await mintOne(db);
    const rotated = (await rotateWebhookEndpointSecret(db, KEY, minted.endpointId))!;
    await expireRotationWindow(db, minted.endpointId);

    const again = (await rotateWebhookEndpointSecret(db, KEY, minted.endpointId))!;

    expect(again.secret).not.toBe(rotated.secret);
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: again.secret, verifiedWith: "current" },
      { secret: rotated.secret, verifiedWith: "previous" },
    ]);
  });

  it("returns null for an unknown endpoint", async () => {
    expect(await rotateWebhookEndpointSecret(db, KEY, "wh_missing")).toBeNull();
  });
});

describe("setWebhookEndpointSecret", () => {
  const IMPORTED = "sentry_client_secret_ab12cd34ef56";

  it("hard-replaces the secret and drops any open rotation window", async () => {
    const minted = await mintOne(db);
    // Open a rotation window first, so the replace has something to clear.
    await rotateWebhookEndpointSecret(db, KEY, minted.endpointId);

    const updated = (await setWebhookEndpointSecret(db, KEY, minted.endpointId, IMPORTED))!;

    expect(updated.id).toBe(minted.endpointId);
    // The imported value is the only accepted secret now: no dual-accept window.
    expect(await revealWebhookEndpointSecret(db, KEY, minted.endpointId)).toBe(IMPORTED);
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(row.previousSecretCiphertext).toBeNull();
    expect(row.previousExpiresAt).toBeNull();
    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: IMPORTED, verifiedWith: "current" },
    ]);
  });

  it("encrypts the imported secret at rest, bound to the endpoint, never in cleartext", async () => {
    const minted = await mintOne(db);

    await setWebhookEndpointSecret(db, KEY, minted.endpointId, IMPORTED);

    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(row.secretCiphertext).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(JSON.stringify(row)).not.toContain(IMPORTED);
  });

  it("trims surrounding whitespace before storing", async () => {
    const minted = await mintOne(db);

    await setWebhookEndpointSecret(db, KEY, minted.endpointId, `   ${IMPORTED}   `);

    expect(await revealWebhookEndpointSecret(db, KEY, minted.endpointId)).toBe(IMPORTED);
  });

  it("rejects a too-short secret without touching the stored one or naming the value", async () => {
    const minted = await mintOne(db);

    await expect(
      setWebhookEndpointSecret(db, KEY, minted.endpointId, "shortsecret"),
    ).rejects.toBeInstanceOf(WebhookSecretInvalidError);
    // The error carries the rule, never the rejected value.
    await expect(
      setWebhookEndpointSecret(db, KEY, minted.endpointId, "shortsecret"),
    ).rejects.toThrow(/between 16 and 200/);
    await expect(
      setWebhookEndpointSecret(db, KEY, minted.endpointId, "shortsecret"),
    ).rejects.not.toThrow(/shortsecret/);
    // The minted secret is untouched.
    expect(await revealWebhookEndpointSecret(db, KEY, minted.endpointId)).toBe(minted.secret);
  });

  it("rejects a too-long secret", async () => {
    const minted = await mintOne(db);

    await expect(
      setWebhookEndpointSecret(db, KEY, minted.endpointId, "x".repeat(201)),
    ).rejects.toBeInstanceOf(WebhookSecretInvalidError);
  });

  it("returns null for an unknown endpoint", async () => {
    expect(await setWebhookEndpointSecret(db, KEY, "wh_missing", IMPORTED)).toBeNull();
  });

  it("enforces the exact length boundaries", async () => {
    const minted = await mintOne(db);
    await expect(
      setWebhookEndpointSecret(db, KEY, minted.endpointId, ""),
    ).rejects.toBeInstanceOf(WebhookSecretInvalidError);
    await expect(
      setWebhookEndpointSecret(db, KEY, minted.endpointId, "x".repeat(15)),
    ).rejects.toBeInstanceOf(WebhookSecretInvalidError);
    expect(
      await setWebhookEndpointSecret(db, KEY, minted.endpointId, "x".repeat(16)),
    ).not.toBeNull();
    expect(
      await setWebhookEndpointSecret(db, KEY, minted.endpointId, "x".repeat(200)),
    ).not.toBeNull();
    await expect(
      setWebhookEndpointSecret(db, KEY, minted.endpointId, "x".repeat(201)),
    ).rejects.toBeInstanceOf(WebhookSecretInvalidError);
  });

  it("does not import onto a revoked endpoint", async () => {
    const minted = await mintOne(db);
    await revokeWebhookEndpoint(db, minted.endpointId);

    expect(
      await setWebhookEndpointSecret(db, KEY, minted.endpointId, IMPORTED),
    ).toBeNull();
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(decryptWebhookSecret(row.secretCiphertext, KEY, row.id)).toBe(minted.secret);
  });
});

describe("revealWebhookEndpointSecret", () => {
  it("returns the current secret without rotating it", async () => {
    const minted = await mintOne(db);

    expect(await revealWebhookEndpointSecret(db, KEY, minted.endpointId)).toBe(minted.secret);

    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(row.previousSecretCiphertext).toBeNull();
    expect(row.previousExpiresAt).toBeNull();
  });

  it("returns null for an unknown endpoint", async () => {
    expect(await revealWebhookEndpointSecret(db, KEY, "wh_missing")).toBeNull();
  });

  it("propagates a key mismatch instead of reporting a missing secret", async () => {
    const minted = await mintOne(db);

    await expect(
      revealWebhookEndpointSecret(db, OTHER_KEY, minted.endpointId),
    ).rejects.toBeInstanceOf(WebhookSecretKeyMismatchError);
  });
});

describe("decryptCandidateSecrets", () => {
  it("offers only the current secret when no rotation happened", async () => {
    const minted = await mintOne(db);
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;

    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: minted.secret, verifiedWith: "current" },
    ]);
  });

  it("drops the replaced secret once its window has expired", async () => {
    const minted = await mintOne(db);
    const rotated = (await rotateWebhookEndpointSecret(db, KEY, minted.endpointId))!;
    await expireRotationWindow(db, minted.endpointId);

    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    expect(decryptCandidateSecrets(row, KEY)).toEqual([
      { secret: rotated.secret, verifiedWith: "current" },
    ]);
  });

  it("honours an injected clock", async () => {
    const minted = await mintOne(db);
    await rotateWebhookEndpointSecret(db, KEY, minted.endpointId);
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;

    const afterWindow = new Date(row.previousExpiresAt!.getTime() + 1);
    expect(decryptCandidateSecrets(row, KEY, afterWindow)).toHaveLength(1);
    const insideWindow = new Date(row.previousExpiresAt!.getTime() - 1);
    expect(decryptCandidateSecrets(row, KEY, insideWindow)).toHaveLength(2);
    // The expiry instant itself is already outside the window.
    expect(decryptCandidateSecrets(row, KEY, row.previousExpiresAt!)).toHaveLength(1);
  });

  it("propagates a key mismatch rather than returning no candidate", async () => {
    const minted = await mintOne(db);
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;

    expect(() => decryptCandidateSecrets(row, OTHER_KEY)).toThrow(
      WebhookSecretKeyMismatchError,
    );
  });

  it("drops a previous secret under a rotated env key, keeping the current one", async () => {
    // The env key was rotated and the endpoint's secret rotated afterward: the
    // current ciphertext is under the new (configured) key, the outgoing one is
    // still under the old key.
    const minted = await mintOne(db);
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;
    const drifted = {
      ...row,
      previousSecretCiphertext: encryptWebhookSecret("whsec_old", OTHER_KEY, row.id),
      previousExpiresAt: new Date(Date.now() + 60_000),
    };

    // One candidate, no throw: the un-decryptable previous is dropped.
    expect(decryptCandidateSecrets(drifted, KEY)).toEqual([
      { secret: minted.secret, verifiedWith: "current" },
    ]);
    // A mismatch on the CURRENT secret is real drift and still propagates.
    expect(() => decryptCandidateSecrets(drifted, OTHER_KEY)).toThrow(
      WebhookSecretKeyMismatchError,
    );
  });

  it("refuses a ciphertext transplanted from another endpoint", async () => {
    const [first, second] = await mintWebhookEndpointsForDefinition(db, KEY, {
      definitionId: DEFINITION_ID,
      nodes: [webhookNode("hook_a"), webhookNode("hook_b")],
    });
    const donor = (await getWebhookEndpointById(db, first!.endpointId))!;
    const target = (await getWebhookEndpointById(db, second!.endpointId))!;

    expect(() =>
      decryptCandidateSecrets({ ...target, secretCiphertext: donor.secretCiphertext }, KEY),
    ).toThrow(WebhookSecretDecryptionError);
  });

  it("propagates a tampered ciphertext as a decryption failure", async () => {
    const minted = await mintOne(db);
    const row = (await getWebhookEndpointById(db, minted.endpointId))!;

    expect(() =>
      decryptCandidateSecrets({ ...row, secretCiphertext: "garbage" }, KEY),
    ).toThrow(WebhookSecretDecryptionError);
  });
});

/** Push an open rotation window into the past; the store only ever writes it
 *  from the database clock, so a test cannot wait it out. */
async function expireRotationWindow(db: Db, endpointId: string): Promise<void> {
  await db
    .update(webhookTriggerEndpoints)
    .set({ previousExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(webhookTriggerEndpoints.id, endpointId));
}
