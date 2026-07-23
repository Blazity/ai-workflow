import { proxyWorker } from "@/lib/api/proxy";
import { handleJsonSchemaInspect } from "../handler";

export async function POST(req: Request) {
  return handleJsonSchemaInspect(req, proxyWorker);
}
