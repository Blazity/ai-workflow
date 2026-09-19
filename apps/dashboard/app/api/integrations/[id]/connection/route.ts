import { proxyWorker } from "@/lib/api/proxy";
import {
  handleIntegrationConnectionDelete,
  handleIntegrationConnectionPut,
} from "../../handler";

// A save runs the provider's connection test before the values become the ones
// in use, so this route has to outlive the worker's own 20 second test ceiling.
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
