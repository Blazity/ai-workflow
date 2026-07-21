import { proxyWorker } from "@/lib/api/proxy";
import { handlePromptUsageGet } from "../../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handlePromptUsageGet({ params }, proxyWorker);
}
