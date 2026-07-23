import { proxyWorker } from "@/lib/api/proxy";
import { handleHarnessProfileAction } from "../../handler";

export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleHarnessProfileAction(
    request,
    context,
    "publish",
    proxyWorker,
  );
}
