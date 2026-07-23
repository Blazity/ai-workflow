import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import {
  archivePrompt,
  createPrompt,
  createPromptReferenceLoader,
  savePromptVersion,
  type PromptLibraryActor,
} from "./store.js";

const ADMIN: PromptLibraryActor = { role: "admin", id: "u_admin", label: "Admin" };

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("createPromptReferenceLoader", () => {
  it("resolves latest to the head version by slug and by legacy numeric id", async () => {
    const { prompt } = await createPrompt(db, { name: "Guidelines", body: "v1", actor: ADMIN });
    await savePromptVersion(db, { promptId: prompt.id, body: "v2", actor: ADMIN });
    const load = createPromptReferenceLoader(db);

    await expect(load({ slug: "guidelines" }, "latest")).resolves.toMatchObject({
      promptId: prompt.id,
      promptName: "Guidelines",
      resolvedVersion: 2,
      body: "v2",
    });
    await expect(load({ legacyPromptId: prompt.id }, "latest")).resolves.toMatchObject({
      resolvedVersion: 2,
      body: "v2",
    });
  });

  it("resolves a pinned version exactly and rejects a missing one", async () => {
    const { prompt } = await createPrompt(db, {
      name: "Pinme",
      body: "v1",
      slots: [
        {
          name: "plan",
          description: "Implementation plan",
          schema: { type: "string" },
          required: true,
        },
      ],
      actor: ADMIN,
    });
    await savePromptVersion(db, {
      promptId: prompt.id,
      body: "v2",
      slots: [],
      actor: ADMIN,
    });
    const load = createPromptReferenceLoader(db);

    await expect(load({ slug: "pinme" }, 1)).resolves.toMatchObject({
      resolvedVersion: 1,
      body: "v1",
      slots: [
        expect.objectContaining({
          name: "plan",
          required: true,
        }),
      ],
    });
    await expect(load({ slug: "pinme" }, 2)).resolves.toMatchObject({
      resolvedVersion: 2,
      body: "v2",
      slots: [],
    });
    await expect(load({ slug: "pinme" }, 9)).rejects.toThrow("does not have version 9");
  });

  it("rejects latest on an archived prompt but keeps pinned versions resolvable", async () => {
    const { prompt } = await createPrompt(db, {
      name: "Old prompt",
      body: "OLD",
      actor: ADMIN,
      tags: ["team"],
    });
    await archivePrompt(db, { promptId: prompt.id, actor: ADMIN });
    const load = createPromptReferenceLoader(db);

    await expect(load({ slug: "old-prompt" }, "latest")).rejects.toThrow("archived");
    await expect(load({ slug: "old-prompt" }, 1)).resolves.toMatchObject({ body: "OLD" });
    await expect(load({ legacyPromptId: prompt.id }, 1)).resolves.toMatchObject({ body: "OLD" });
  });

  it("fails cleanly on unknown targets and out-of-range ids or versions", async () => {
    const load = createPromptReferenceLoader(db);

    await expect(load({ slug: "nope" }, "latest")).rejects.toThrow("Prompt nope does not exist");
    await expect(load({ legacyPromptId: 999_999 }, "latest")).rejects.toThrow("does not exist");
    // Past int4: must be the clean error, not a driver overflow.
    await expect(load({ legacyPromptId: 99_999_999_999 }, "latest")).rejects.toThrow("does not exist");
    await expect(load({ slug: "nope" }, 99_999_999_999)).rejects.toThrow("does not have version");
  });
});
