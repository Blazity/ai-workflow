import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import {
  loadCount,
  readAccess,
  resetStore,
  writeAccess,
} from "../../workflow-test-fixtures/run-start-freeze/store.js";
import { probeRunStartFreeze } from "../../workflow-test-fixtures/run-start-freeze/workflow.js";

/**
 * The engine wave's central claim, against the real Workflow runtime rather
 * than against a unit test's idea of one.
 *
 * A run reads the repository catalog ONCE, in a step at its start, and every
 * later decision uses that value. That is only safe if a run suspended across
 * an operator's edit replays the recorded result instead of reading the store
 * again. Everything else in the wave (the frozen list on the run context, the
 * refusals by name, `appliesToRunsInFlight: "next run"`) rests on it, and no
 * test outside this configuration can see it, because it is a property of the
 * journal and not of any function.
 */
describe("run-start values survive a resume", () => {
  it("resumes with the access the run started with while the store has moved on", async () => {
    resetStore();
    const started = { activated: true, enabledKeys: ["github:acme/api"] };
    const edited = { activated: true, enabledKeys: ["gitlab:group/tool"] };
    writeAccess(started);

    const run = await start(probeRunStartFreeze, [{ sleepMs: 4_000 }]);

    // Wait for the run-start step's body to have executed, then move the store
    // while the run is suspended in its sleep. Polling the marker rather than
    // sleeping a guessed interval, so a slow builder cannot turn this into a
    // race that passes for the wrong reason.
    const deadline = Date.now() + 60_000;
    while (loadCount() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(loadCount()).toBe(1);
    writeAccess(edited);
    expect(readAccess()).toEqual(edited);

    await expect(run.returnValue).resolves.toEqual({
      // The point of the whole wave.
      frozen: started,
      // The control: the store really did change under the suspended run, so
      // `frozen` is a journal replay and not a stale read.
      live: edited,
    });

    // And the step body ran exactly once across the suspension. Without this a
    // run that never replayed would report the same thing and prove nothing.
    expect(loadCount()).toBe(1);
  }, 120_000);
});
