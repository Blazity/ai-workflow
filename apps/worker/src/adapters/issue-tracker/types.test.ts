import { IssueTrackerNotFoundError as SdkNotFoundError } from "@integrations/sdk";
import { describe, expect, it } from "vitest";
import { IssueTrackerNotFoundError } from "./types.js";

// About ten core sites recognise a missing ticket with `instanceof`. The port
// moved into @integrations/sdk and this file re-exports it; if the two ever
// became different classes, an integration's "not found" would read as an
// unknown failure everywhere core branches on it.
describe("the issue tracker shim", () => {
  it("re-exports the SDK's not-found error as the same class", () => {
    expect(IssueTrackerNotFoundError).toBe(SdkNotFoundError);
  });

  it("keeps the error's name, code and message", () => {
    const error = new SdkNotFoundError("Ticket", "AIW-1");
    expect(error).toBeInstanceOf(IssueTrackerNotFoundError);
    expect(error.name).toBe("IssueTrackerNotFoundError");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Ticket not found: AIW-1");
  });
});
