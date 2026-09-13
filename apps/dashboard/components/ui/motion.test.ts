import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { MOTION_BASE_MS, MOTION_FAST_MS, MOTION_SLOW_MS } from "./index";

test("primitive source uses motion tokens instead of literal durations", () => {
  const directory = import.meta.dirname;
  const sourceFiles = readdirSync(directory).filter((file) => /\.(ts|tsx)$/.test(file));
  for (const file of sourceFiles) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\d+ms/, `${file} contains a literal motion duration`);
  }
});

test("motion constants match the global CSS duration tokens", () => {
  const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  for (const [token, duration] of [
    ["fast", MOTION_FAST_MS],
    ["base", MOTION_BASE_MS],
    ["slow", MOTION_SLOW_MS],
  ] as const) {
    assert.match(styles, new RegExp(`--motion-${token}:\\s*${duration}ms;`));
  }
});
