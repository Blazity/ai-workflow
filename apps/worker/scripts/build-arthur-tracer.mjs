#!/usr/bin/env node
// Generates src/sandbox/arthur-tracer.ts from the Arthur Engine tracer source.
// Regenerate whenever arthur-engine/integrations/claude-code/claude_code_tracer.py changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, "..");
// arthur-engine lives as a sibling of the monorepo root (apps/worker → apps → repo → arthur-engine)
const monorepoRoot = path.resolve(workerRoot, "..", "..");
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
  console.error(`Arthur tracer not found at ${sourcePath}.`);
  console.error("Set ARTHUR_TRACER_SRC to override.");
  process.exit(1);
}

const bytes = fs.readFileSync(sourcePath);
const base64 = bytes.toString("base64");
const outPath = path.resolve(workerRoot, "src", "sandbox", "arthur-tracer.ts");

const out = `// AUTO-GENERATED — do not edit by hand.
// Source: ${path.relative(workerRoot, sourcePath)}
// Regenerate: pnpm build:arthur-tracer
//
// Base64-encoded Python source of the Arthur Engine Claude Code tracer.
// Bundled so Nitro reliably ships it with the Vercel deployment; decoded at
// runtime and written into each provisioned sandbox under ~/.claude/hooks/.
export const ARTHUR_TRACER_PY_BASE64 = "${base64}";
`;

fs.writeFileSync(outPath, out);
console.log(`Wrote ${path.relative(workerRoot, outPath)} (${bytes.length} bytes -> ${base64.length} base64 chars)`);
