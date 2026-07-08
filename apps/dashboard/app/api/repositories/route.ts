import { proxyWorker } from "@/lib/api/proxy";
import { handleRepositoriesGet } from "../pre-pr-checks/handler";

export async function GET() {
  return handleRepositoriesGet(proxyWorker);
}
