#!/usr/bin/env node
// Generates tracer.generated.ts from the Arthur Engine tracer source.
// Regenerate whenever arthur-engine/integrations/claude-code/claude_code_tracer.py changes.
import fs from "node:fs";
import path from "node:path";

const packageRoot = import.meta.dirname;
// arthur-engine lives as a sibling of the monorepo root
// (integrations/arthur -> integrations -> repo -> arthur-engine)
const monorepoRoot = path.resolve(packageRoot, "..", "..");
const defaultSource = path.resolve(
  monorepoRoot,
  "..",
  "arthur-engine",
  "integrations",
  "claude-code",
  "claude_code_tracer.py",
);
const sourcePath = process.env.ARTHUR_TRACER_SRC
  ? path.resolve(process.env.ARTHUR_TRACER_SRC)
  : defaultSource;

if (!fs.existsSync(sourcePath)) {
  console.error(`The Arthur tracer source is not at ${sourcePath}.`);
  console.error("Set ARTHUR_TRACER_SRC to override.");
  process.exit(1);
}

const bytes = fs.readFileSync(sourcePath);
const base64 = bytes.toString("base64");
const outPath = path.resolve(packageRoot, "tracer.generated.ts");

const out = `// AUTO-GENERATED. Do not edit by hand.
// Source: ${path.relative(path.dirname(monorepoRoot), sourcePath)}
// Regenerate: pnpm --filter @integrations/arthur run build:tracer
//
// Base64-encoded Python source of the Arthur Engine tracer, carried as data so
// it travels with whatever bundles this package, and handed to core through
// the agent_tracing port as a file to write into each sandbox.
export const ARTHUR_TRACER_PY_BASE64 = "${base64}";
`;

fs.writeFileSync(outPath, out);
console.log(`Wrote ${path.relative(packageRoot, outPath)} (${bytes.length} bytes -> ${base64.length} base64 chars)`);
