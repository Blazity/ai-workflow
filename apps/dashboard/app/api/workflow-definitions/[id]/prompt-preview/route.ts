import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionPromptPreview } from "../../handler";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleDefinitionPromptPreview(req, context, proxyWorker);
}
