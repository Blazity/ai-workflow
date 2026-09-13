import { config } from "dotenv";
import { assertNoRetiredEnvironmentVariables } from "../src/services/settings/retired-environment.js";

config({ path: [".env.local", ".env"], quiet: true });

try {
  assertNoRetiredEnvironmentVariables(process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[check-retired-env] ${message.replace(/\s*\n\s*/gu, " ")}`);
  process.exitCode = 1;
}
