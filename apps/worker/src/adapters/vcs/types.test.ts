import {
  FatalError as SdkFatalError,
  REVIEW_LEDGER_MAX_CONTEXT_THREADS as SdkMaxContextThreads,
  REVIEW_LEDGER_MAX_WORK_ITEMS as SdkMaxWorkItems,
} from "@integrations/sdk";
import { FatalError } from "workflow";
import { describe, expect, it } from "vitest";
import { REVIEW_LEDGER_MAX_CONTEXT_THREADS, REVIEW_LEDGER_MAX_WORK_ITEMS } from "./types.js";

describe("the VCS shim", () => {
  it("re-exports the review ledger limits the adapters apply, unchanged at 20", () => {
    expect(REVIEW_LEDGER_MAX_WORK_ITEMS).toBe(SdkMaxWorkItems);
    expect(REVIEW_LEDGER_MAX_CONTEXT_THREADS).toBe(SdkMaxContextThreads);
    expect([REVIEW_LEDGER_MAX_WORK_ITEMS, REVIEW_LEDGER_MAX_CONTEXT_THREADS]).toEqual([20, 20]);
  });
});

// Adapters throw the DevKit's FatalError today to stop a step from retrying.
// The SDK cannot import the DevKit, so integrations throw the SDK's FatalError
// instead, and that works only because the DevKit recognises a fatal error by
// its name (`FatalError.is`, which its step handler calls). A DevKit upgrade
// that switched to a brand or to instanceof would turn every "retrying cannot
// help" from an integration into a retried failure; this is where that shows.
describe("the SDK's FatalError", () => {
  it("is fatal to the Workflow DevKit without translation", () => {
    const error = new SdkFatalError("The provider refused the token.");
    expect(FatalError.is(error)).toBe(true);
    expect(error.name).toBe("FatalError");
    expect(error.message).toBe("The provider refused the token.");
  });

  it("is not confused with an ordinary error", () => {
    expect(FatalError.is(new Error("timeout"))).toBe(false);
  });
});
