/**
 * Every recorded or composed Bitbucket payload is the bytes its `.source.txt`
 * describes. A fixture reshaped to make an assertion pass changes its digest
 * and fails here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const directory = new URL("./test-fixtures/", import.meta.url);
const bodies = readdirSync(directory).filter((name) => name.endsWith(".json"));

test("every payload has its provenance beside it", () => {
  assert.equal(bodies.length, 4);
  for (const name of bodies) {
    const source = readFileSync(new URL(name.replace(/\.json$/u, ".source.txt"), directory), "utf8");
    assert.match(source, /^Source URL: https:\/\/support\.atlassian\.com\/\S+/mu, name);
    assert.match(source, /^Retrieved: \d{4}-\d{2}-\d{2}$/mu, name);
    assert.match(source, /^How these bytes were made:$/mu, name);
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
