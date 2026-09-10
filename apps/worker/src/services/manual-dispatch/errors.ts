import type { ManualDispatchBlockerCode } from "@shared/contracts";

export class ManualDispatchError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ManualDispatchBlockerCode,
    message: string,
  ) {
    super(message);
    this.name = "ManualDispatchError";
  }
}
