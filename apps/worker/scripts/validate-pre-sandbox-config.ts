import { loadPreSandboxConfig } from "../src/pre-sandbox/config.js";

try {
  const config = loadPreSandboxConfig();
  console.log(`Validated pre-sandbox config with ${config.preSandbox.steps.length} step(s).`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
