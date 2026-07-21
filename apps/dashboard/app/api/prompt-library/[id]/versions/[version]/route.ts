import { proxyWorker } from "@/lib/api/proxy";
import { handlePromptVersionGet } from "../../../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
) {
  return handlePromptVersionGet({ params }, proxyWorker);
}
