import { proxyWorker } from "@/lib/api/proxy";
import { handleHarnessSkillAction } from "../../harness-profiles/handler";

const SKILL_IMPORT_TIMEOUT_MS = 60_000;

export const maxDuration = 60;

export function POST(request: Request) {
  return handleHarnessSkillAction(
    request,
    "import",
    (path, init) => proxyWorker(path, init, SKILL_IMPORT_TIMEOUT_MS),
  );
}
