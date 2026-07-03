import { proxyWorker } from "@/lib/api/proxy";
import { handleUserRolePatch } from "./handler";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  return handleUserRolePatch(req, { params }, proxyWorker);
}
