import { proxyWorker } from "@/lib/api/proxy";
import { handleClarificationAnswer } from "../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleClarificationAnswer(req, { params }, proxyWorker);
}
