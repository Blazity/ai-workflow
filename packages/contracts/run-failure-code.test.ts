import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  RUN_FAILURE_CODES,
  integrationUnavailableFailureCode,
  isRunFailureCode,
} from "./run-registry.js";
import type { IntegrationUnavailableReason } from "./api.js";

/**
 * The code a machine reads beside the sentence a human reads.
 *
 * The sentence is copy and we will keep rewriting it; a reader built on the
 * copy breaks silently the first time someone improves the wording. So the set
 * is closed, membership is a type, and the only way to mint one is a function
 * whose input is the reason itself.
 */

describe("the closed set of run failure codes", () => {
  it("maps every reason a run can be stopped for to a code in the set", () => {
    // Exhaustive by construction: add a fourth reason to
    // IntegrationUnavailableReason and this array stops typechecking, which is
    // the point. A reason with no code would reach the column as null and read
    // as "no code", not as the new case.
    const reasons: readonly IntegrationUnavailableReason[] = [
      "disconnected",
      "disabled",
      "reconfigured",
    ];

    const codes = reasons.map((reason) => integrationUnavailableFailureCode(reason));

    expect(codes).toEqual([
      "integration_unavailable.disconnected",
      "integration_unavailable.disabled",
      "integration_unavailable.reconfigured",
    ]);
    expect(codes.every((code) => isRunFailureCode(code))).toBe(true);
  });

  it("spells every member as family.case, so a reader can match a family", () => {
    // S3 asks "was this an integration being unavailable?" before it asks which
    // of the three. A member with no dot, or with two, makes that prefix match
    // wrong rather than merely unhelpful.
    const shaped = RUN_FAILURE_CODES.filter((code) =>
      /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(code),
    );

    expect(shaped).toEqual([...RUN_FAILURE_CODES]);
  });

  it("refuses a value outside the set, including one that merely looks like a member", () => {
    // The guard stands between the column and a typo, a stale code from an
    // older deployment, or a string someone assembled by hand.
    expect(isRunFailureCode("integration_unavailable.disabled")).toBe(true);
    expect(isRunFailureCode("integration_unavailable.retired")).toBe(false);
    expect(isRunFailureCode("integration_unavailable")).toBe(false);
    expect(isRunFailureCode("")).toBe(false);
    expect(isRunFailureCode(null)).toBe(false);
    expect(isRunFailureCode(7)).toBe(false);
  });

  it("holds no duplicate, so a code identifies one case", () => {
    expect(new Set<string>(RUN_FAILURE_CODES).size).toBe(RUN_FAILURE_CODES.length);
  });
});
