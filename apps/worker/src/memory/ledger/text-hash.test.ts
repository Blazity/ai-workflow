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
});
