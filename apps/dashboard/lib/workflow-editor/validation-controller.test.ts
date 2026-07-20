import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowDefinitionValidationResponse } from "@shared/contracts";
import {
  createWorkflowValidationController,
  type ValidationTimer,
  type WorkflowValidationState,
} from "./validation-controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeTimer() {
  let callback: (() => void) | null = null;
  let cancellations = 0;
  const timer: ValidationTimer = (next) => {
    callback = next;
    return () => {
      cancellations += 1;
      callback = null;
    };
  };
  return {
    timer,
    fire() {
      const pending = callback;
      callback = null;
      pending?.();
    },
    get cancellations() {
      return cancellations;
    },
  };
}

const valid: WorkflowDefinitionValidationResponse = {
  valid: true,
  issues: [],
  nodeContracts: {},
};
const invalid: WorkflowDefinitionValidationResponse = {
  valid: false,
  issues: [
    {
      code: "deployment",
      nodeId: "consumer",
      message: "Missing required input",
    },
  ],
  nodeContracts: {},
};

test("semantic edits clear stale success and debounce validation", async () => {
  const clock = fakeTimer();
  const requests: string[] = [];
  const states: WorkflowValidationState[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    validate: async (semantic) => {
      requests.push(semantic);
      return valid;
    },
    onState: (state) => states.push(state),
  });

  controller.schedule("first");
  controller.schedule("second");

  assert.deepEqual(states, [
    { status: "checking", issues: [], nodeContracts: {} },
    { status: "checking", issues: [], nodeContracts: {} },
  ]);
  assert.equal(clock.cancellations, 1);
  assert.deepEqual(requests, []);

  clock.fire();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(requests, ["second"]);
  assert.deepEqual(states.at(-1), { status: "valid", issues: [], nodeContracts: {} });
});

test("a newer edit aborts the in-flight validation request", async () => {
  const clock = fakeTimer();
  const first = deferred<WorkflowDefinitionValidationResponse>();
  const signals: AbortSignal[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    validate: async (_semantic, signal) => {
      signals.push(signal);
      return first.promise;
    },
    onState: () => undefined,
  });

  controller.schedule("first");
  clock.fire();
  assert.equal(signals[0]?.aborted, false);

  controller.schedule("second");
  assert.equal(signals[0]?.aborted, true);
  first.resolve(valid);
});

test("an older response cannot overwrite the latest validation result", async () => {
  const clock = fakeTimer();
  const first = deferred<WorkflowDefinitionValidationResponse>();
  const second = deferred<WorkflowDefinitionValidationResponse>();
  const responses = [first, second];
  const states: WorkflowValidationState[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    validate: async () => responses.shift()!.promise,
    onState: (state) => states.push(state),
  });

  controller.schedule("first");
  clock.fire();
  controller.schedule("second");
  clock.fire();

  second.resolve(valid);
  await Promise.resolve();
  await Promise.resolve();
  first.resolve(invalid);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(states.at(-1), { status: "valid", issues: [], nodeContracts: {} });
  assert.equal(states.some((state) => state.status === "invalid"), false);
});
