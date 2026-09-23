import { describe, expect, it } from "vitest";
import type { VCSAdapter } from "@integrations/sdk";
import type { DeferredMembers, DeferredVcsAdapter } from "./vcs-runtime.js";

/**
 * The lazy repository runtime resolves a connection on the first call and
 * forwards every call once it has, so each forwarded member returns a Promise.
 * A synchronous member forwarded that way returned a Promise too, which reads
 * as `true`: every failed check once compared equal to every other through it.
 *
 * These cases are checked by the compiler (`pnpm run typecheck` covers test
 * files): each `@ts-expect-error` fails the build the day the line under it
 * compiles.
 */
describe("a deferred adapter", () => {
  it("offers only the members it can forward before the connection resolves", () => {
    type Probe = {
      read(prId: number): Promise<string>;
      same(left: unknown, right: unknown): boolean;
    };
    const use = (deferred: DeferredMembers<Probe>) => {
      void deferred.read(1);
      // @ts-expect-error a synchronous member cannot be answered before the connection resolves
      void deferred.same(1, 1);
    };
    expect(use).toBeTypeOf("function");
  });

  it("is a whole VCS adapter while every member of the port is asynchronous", () => {
    // A synchronous member added to the port removes itself from the deferred
    // type, and every place that hands the lazy runtime on as an adapter stops
    // compiling, instead of receiving a Promise where it expected an answer.
    const asPort = (deferred: DeferredVcsAdapter): VCSAdapter => deferred;
    expect(asPort).toBeTypeOf("function");
  });
});
