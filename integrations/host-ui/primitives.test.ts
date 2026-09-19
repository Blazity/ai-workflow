// What this package promises an integration, asserted against the source so a
// change to the promise has to be a deliberate one.
//
// The mistakes these catch are all the same mistake: the host UI quietly
// becoming the dashboard's component library. A `className` passthrough, an
// overlay, a router, a colour nobody else uses. Each of those is how a
// contributed page stops looking like the product, or stops being contained by
// it, and none of them would fail a typecheck.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = import.meta.dirname;
const primitives = readFileSync(join(here, "primitives.tsx"), "utf8");
const index = readFileSync(join(here, "index.ts"), "utf8");

/** Every name the package exports, read off the entry rather than imported:
 *  importing it would need a JSX runtime the test does not otherwise want. */
function exportedNames(source: string): string[] {
  return [...source.matchAll(/^\s{2}(?:type\s+)?([A-Za-z][A-Za-z0-9]*),$/gmu)]
    .map((match) => match[1]!)
    .toSorted();
}

test("the package exports exactly the contract and the primitives", () => {
  assert.deepEqual(exportedNames(index), [
    "Card",
    "Chip",
    "EmptyState",
    "ErasedIntegrationDashboard",
    "ErasedIntegrationDashboardEntry",
    "ExternalLink",
    "HostTone",
    "IntegrationDashboard",
    "IntegrationDashboardPages",
    "IntegrationPageComponent",
    "IntegrationPageProps",
    "KeyValue",
    "KeyValueItem",
    "Notice",
    "Page",
    "Section",
    "Table",
    "TableColumn",
    "TableRow",
    "defineIntegrationDashboard",
  ]);
});

test("nothing here lets a page escape the cockpit's content area", () => {
  // A dialog, an overlay or a portal is an integration taking the screen. A
  // router or an internal link is an integration deciding where somebody is.
  for (const forbidden of [
    "createPortal",
    "Dialog",
    "Modal",
    "Overlay",
    "Drawer",
    "useRouter",
    "next/link",
    "next/navigation",
  ]) {
    assert.ok(
      !index.includes(`  ${forbidden},`) && !primitives.includes(forbidden),
      `${forbidden} would let a contributed page take the screen or move the person; it does not belong in the host UI`,
    );
  }
});

test("no primitive takes a className, so its look stays the product's", () => {
  assert.ok(
    !/className[?]?\s*:/u.test(primitives.replace(/className=/gu, "")),
    "a className prop on a host primitive is how two screens come to disagree about what a card looks like; a page wraps a primitive instead of redressing it",
  );
});

test("the primitives use motion and colour tokens, not literals", () => {
  assert.ok(!/transition-all/u.test(primitives), "motion classes name the properties they animate");
  assert.ok(
    !/duration-(?:\[\d+ms\]|\d+)/u.test(primitives),
    "durations come from --motion-fast, --motion-base and --motion-slow",
  );
  // The two the cockpit already draws its failure and warning bands with, and
  // nothing else: a third raw colour means a band that matches no other band.
  const rawColours = [...primitives.matchAll(/#[0-9A-Fa-f]{6}/gu)].map((match) => match[0]);
  assert.deepEqual([...new Set(rawColours)].toSorted(), ["#A23E18", "#F0B8AE"]);
});

test("a link out of the product cannot hand the destination our window", () => {
  const anchor = primitives.slice(primitives.indexOf("export function ExternalLink"));
  assert.match(anchor, /target="_blank"/u);
  assert.match(anchor, /rel="noreferrer noopener"/u);
});
