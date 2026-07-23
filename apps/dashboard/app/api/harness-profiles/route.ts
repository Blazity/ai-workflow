import { proxyWorker } from "@/lib/api/proxy";
import {
  handleHarnessProfilesGet,
  handleHarnessProfilesPost,
} from "./handler";

export function GET(request: Request) {
  return handleHarnessProfilesGet(request, proxyWorker);
}

export function POST(request: Request) {
  return handleHarnessProfilesPost(request, proxyWorker);
}
