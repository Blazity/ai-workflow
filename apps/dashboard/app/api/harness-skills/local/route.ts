import { proxyWorker } from "@/lib/api/proxy";
import {
  handleHarnessLocalSkillDiscovery,
  handleHarnessSkillAction,
} from "../../harness-profiles/handler";

export function GET() {
  return handleHarnessLocalSkillDiscovery(proxyWorker);
}

export function POST(request: Request) {
  return handleHarnessSkillAction(request, "local", proxyWorker);
}
