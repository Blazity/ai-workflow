import { proxyWorker } from "@/lib/api/proxy";
import { handleIntegrationTest } from "../../handler";

// Contacts the provider, so the same ceiling the save route carries, held
// above `PROVIDER_CALL_CEILING_MS` by `../../route-durations.test.ts`.
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleIntegrationTest((await params).id, proxyWorker);
}
