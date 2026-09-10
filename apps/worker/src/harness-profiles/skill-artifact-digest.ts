import { createHash } from "node:crypto";

export function sha256Digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
