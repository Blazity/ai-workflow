import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryTextHash } from "./text-hash.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("memoryTextHash", () => {
  it("hashes the text the way the stores compare it: bullets, case, spacing and a final period folded", async () => {
    expect(await memoryTextHash("  - * Use   pnpm,\tnot NPM.  ")).toBe(sha("use pnpm, not npm"));
  });

  it("gives two spellings of one entry the same hash, and two entries different ones", async () => {
    expect(await memoryTextHash("Run tests with vitest")).toBe(await memoryTextHash("- run tests with vitest."));
    expect(await memoryTextHash("Run tests with vitest")).not.toBe(await memoryTextHash("Run tests with jest"));
  });

  it("ignores NUL characters, so a text hashes the same before and after the ledger strips them", async () => {
    expect(await memoryTextHash("Use\u0000 pnpm")).toBe(sha("use pnpm"));
  });

  it("hashes an accent typed as a combining mark as the precomposed one, as the stores forget by", async () => {
    const composed = "Caf\u00e9 opens at 8";
    const decomposed = "Cafe\u0301 opens at 8";

    expect(await memoryTextHash(decomposed)).toBe(await memoryTextHash(composed));
    expect(await memoryTextHash(decomposed)).toBe(sha("caf\u00e9 opens at 8"));
  });

  it("strips every leading list marker, as the store port's normalisation does", async () => {
    expect(await memoryTextHash("- * - Use pnpm.")).toBe(sha("use pnpm"));
  });
});
