/**
 * Records the scheduling golden fixture.
 *
 * The fixture exists to prove that moving the scheduler into
 * `@shared/workflow-graph` changed no dispatch order, so it may only ever be
 * rewritten by a person who decided an order should change. Running it without
 * `--write` prints the difference and exits non-zero.
 *
 * The recording itself lives in `src/test-support/scheduling-golden.ts`, shared
 * with the golden test, so the fixture is asserted by exactly what wrote it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  readSchedulingGolden,
  renderSchedulingGolden,
  SCHEDULING_GOLDEN_PATH,
  SCHEDULING_GOLDEN_RECORD_COMMAND,
} from "../src/test-support/scheduling-golden.js";

const write = process.argv.includes("--write");
const rendered = renderSchedulingGolden();
const current = readSchedulingGolden();

if (rendered === current) {
  console.log(`Golden fixture is current: ${SCHEDULING_GOLDEN_PATH}`);
  process.exit(0);
}

if (!write) {
  console.error(
    `Golden fixture differs from the recorded one.\n` +
      `  recorded: ${current === null ? "(absent)" : `${current.length} bytes`}\n` +
      `  computed: ${rendered.length} bytes\n` +
      `Re-record it only when a dispatch order was meant to change: ` +
      SCHEDULING_GOLDEN_RECORD_COMMAND,
  );
  process.exit(1);
}

mkdirSync(dirname(SCHEDULING_GOLDEN_PATH), { recursive: true });
writeFileSync(SCHEDULING_GOLDEN_PATH, rendered);
console.log(`Wrote ${rendered.length} bytes to ${SCHEDULING_GOLDEN_PATH}`);
