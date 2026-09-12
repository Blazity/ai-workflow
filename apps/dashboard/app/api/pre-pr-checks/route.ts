import { proxyWorker } from "@/lib/api/proxy";
import { handlePrePrChecksGet } from "./handler";

// Read only. Writing a repository's script groups happens on the Repositories
// entry, through `PUT /api/repository-catalog/:id`, which carries the reason and
// mints a profile version; this route survives because the editor's group picker
// still reads the composed configuration to offer real group names.
export async function GET() {
  return handlePrePrChecksGet(proxyWorker);
}
