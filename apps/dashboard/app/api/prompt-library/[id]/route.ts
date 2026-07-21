import { proxyWorker } from "@/lib/api/proxy";
import {
  handlePromptDelete,
  handlePromptGet,
  handlePromptPatch,
  handlePromptPut,
} from "../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handlePromptGet({ params }, proxyWorker);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handlePromptPut(req, { params }, proxyWorker);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handlePromptPatch(req, { params }, proxyWorker);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handlePromptDelete({ params }, proxyWorker);
}
