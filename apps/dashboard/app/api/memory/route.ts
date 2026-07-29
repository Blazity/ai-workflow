import { proxyWorker } from "@/lib/api/proxy";
import { handleMemoryDelete } from "./handler";

export async function DELETE(req: Request) {
  return handleMemoryDelete(req, proxyWorker);
}
