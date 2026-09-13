import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

test("primitive source uses motion tokens instead of literal durations", () => {
  const directory = import.meta.dirname;
  const sourceFiles = readdirSync(directory).filter((file) => /\.(ts|tsx)$/.test(file));
  for (const file of sourceFiles) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\d+ms/, `${file} contains a literal motion duration`);
  }
});
