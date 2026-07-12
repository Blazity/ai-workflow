import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionsCreate, handleDefinitionsList } from "./handler";

export async function GET() {
  return handleDefinitionsList(proxyWorker);
}

export async function POST(req: Request) {
  return handleDefinitionsCreate(req, proxyWorker);
}
