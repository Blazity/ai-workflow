import { proxyWorker } from "@/lib/api/proxy";
import { handlePromptsCreate, handlePromptsList } from "./handler";

export async function GET(req: Request) {
  return handlePromptsList(req, proxyWorker);
}

export async function POST(req: Request) {
  return handlePromptsCreate(req, proxyWorker);
}
