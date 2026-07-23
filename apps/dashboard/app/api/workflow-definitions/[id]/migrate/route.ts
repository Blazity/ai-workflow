import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionMigrate } from "../../handler";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleDefinitionMigrate(req, context, proxyWorker);
}
