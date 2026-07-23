import { pathToFileURL } from "node:url";
import { runHarnessProfilePreviewCanary } from "../harness-profiles/preview-canary.js";

export async function runReplayPreviewCanary(
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runHarnessProfilePreviewCanary(source, { verifyReplay: true });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runReplayPreviewCanary().catch((error) => {
    console.error(
      `[replay-canary] FAIL: ${
        error instanceof Error ? error.message : "Unknown canary failure"
      }`,
    );
    process.exitCode = 1;
  });
}
