import { proxyWorker } from "@/lib/api/proxy";
import {
  handleIntegrationConnectionDelete,
  handleIntegrationConnectionPut,
} from "../../handler";

// A save runs the provider's connection test before the values become the ones
// in use, so this route has to outlive the dashboard's wait on the worker
// (`PROVIDER_CALL_CEILING_MS`, which is `INTEGRATION_PROVIDER_WAIT_MS` plus a
// margin). A segment config has to be a literal, so the relation is held by
// `app/api/integrations/route-durations.test.ts` instead.
export const maxDuration = 60;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleIntegrationConnectionPut((await params).id, request, proxyWorker);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleIntegrationConnectionDelete((await params).id, proxyWorker);
}
