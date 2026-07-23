import { proxyWorker } from "@/lib/api/proxy";
import { handleHarnessSkillAction } from "../../harness-profiles/handler";

export function POST(request: Request) {
  return handleHarnessSkillAction(request, "import", proxyWorker);
}
