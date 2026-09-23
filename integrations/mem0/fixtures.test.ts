/**
 * Every recorded Mem0 body is the bytes its `.source.txt` describes. A fixture
 * reshaped to make an assertion pass changes its digest and fails here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const directory = new URL("./test-fixtures/", import.meta.url);
const bodies = readdirSync(directory).filter((name) => name.endsWith(".json"));

test("every recorded body has its provenance beside it", () => {
  assert.ok(bodies.length > 0);
  for (const name of bodies) {
    const source = readFileSync(new URL(name.replace(/\.json$/u, ".source.txt"), directory), "utf8");
    assert.match(source, /^Source URL: \S+/mu, name);
    assert.match(source, /^Retrieved: \d{4}-\d{2}-\d{2}$/mu, name);
  }
});

for (const name of bodies) {
  test(`${name} is the bytes its source names`, () => {
    const source = readFileSync(new URL(name.replace(/\.json$/u, ".source.txt"), directory), "utf8");
    const pinned = /^SHA-256: ([0-9a-f]{64})$/mu.exec(source)?.[1];
    const actual = createHash("sha256").update(readFileSync(new URL(name, directory))).digest("hex");
    assert.equal(actual, pinned);
  });
}
