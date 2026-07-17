import { proxyWorker } from "@/lib/api/proxy";
import {
  handleDefinitionDelete,
  handleDefinitionGet,
  handleDefinitionPatch,
  handleDefinitionPut,
} from "../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleDefinitionGet({ params }, proxyWorker);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleDefinitionPut(req, { params }, proxyWorker);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleDefinitionPatch(req, { params }, proxyWorker);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleDefinitionDelete({ params }, proxyWorker);
}
