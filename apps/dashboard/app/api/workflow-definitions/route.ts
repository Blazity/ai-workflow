import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionsCreate } from "./handler";

export async function POST(req: Request) {
  return handleDefinitionsCreate(req, proxyWorker);
}
