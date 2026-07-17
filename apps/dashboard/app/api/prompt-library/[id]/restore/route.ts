import { proxyWorker } from "@/lib/api/proxy";
import { handlePromptRestore } from "../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handlePromptRestore(req, { params }, proxyWorker);
}
