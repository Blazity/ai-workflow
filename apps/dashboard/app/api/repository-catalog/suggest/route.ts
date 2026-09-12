import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogSuggest } from "../handler";

// The worker's worst case is 150 s (60 s profile read plus 90 s model call), so
// this route has to outlive both the dashboard's default fetch timeout and that
// bound. `SUGGEST_TIMEOUT_MS` (160 s) is what the handler passes to proxyWorker;
// `maxDuration` has to sit above it or the platform kills the invocation before
// the proxy can turn the worker's silence into an explained 504.
export const maxDuration = 180;

export function POST(request: Request) {
  return handleCatalogSuggest(request, proxyWorker);
}
