/**
 * Records the deployment-issue golden fixture.
 *
 * The fixture exists to prove that moving the graph rules into
 * `@shared/workflow-graph` changed no verdict, so it may only ever be rewritten
 * by a person who decided a verdict should change. Running it without `--write`
 * prints the diff summary and exits non-zero, and the golden test never calls
 * this file at all: a fixture a test can regenerate proves nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFINITION_GOLDEN_PATH,
  renderDefinitionGolden,
} from "../src/test-support/definition-golden-corpus.js";

const write = process.argv.includes("--write");
const rendered = renderDefinitionGolden();
const current = readCurrent();

if (rendered === current) {
  console.log(`Golden fixture is current: ${DEFINITION_GOLDEN_PATH}`);
  process.exit(0);
}

if (!write) {
  console.error(
    `Golden fixture differs from the recorded one.\n` +
      `  recorded: ${current === null ? "(absent)" : `${current.length} bytes`}\n` +
      `  computed: ${rendered.length} bytes\n` +
      `Re-record it only when a verdict was meant to change: pnpm run capture:definition-golden -- --write`,
  );
  process.exit(1);
}

mkdirSync(dirname(DEFINITION_GOLDEN_PATH), { recursive: true });
writeFileSync(DEFINITION_GOLDEN_PATH, rendered);
console.log(`Wrote ${rendered.length} bytes to ${DEFINITION_GOLDEN_PATH}`);

function readCurrent(): string | null {
  try {
    return readFileSync(DEFINITION_GOLDEN_PATH, "utf8");
  } catch {
    return null;
  }
}
