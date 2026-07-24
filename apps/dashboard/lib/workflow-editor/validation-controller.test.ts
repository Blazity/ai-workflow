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

function fakeClock() {
  let callback: (() => void) | null = null;
  let nowMs = 0;
  let cancellations = 0;
  const delays: number[] = [];
  const timer: ValidationTimer = (next, delayMs) => {
    callback = next;
    delays.push(delayMs);
    return () => {
      if (callback === next) {
        cancellations += 1;
        callback = null;
      }
    };
  };
  return {
    timer,
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
    fire() {
      const pending = callback;
      callback = null;
      pending?.();
    },
    get pending() {
      return callback !== null;
    },
    get cancellations() {
      return cancellations;
    },
    get delays() {
      return delays;
    },
  };
}

const valid: WorkflowDefinitionValidationResponse = {
  valid: true,
  issues: [],
  nodeContracts: {},
  availableValuesByNode: {},
};
const invalid: WorkflowDefinitionValidationResponse = {
  valid: false,
  issues: [
    {
      code: "deployment",
      severity: "error",
      nodeId: "consumer",
      message: "Missing required input",
    },
  ],
  nodeContracts: {},
  availableValuesByNode: {},
};

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test("semantic edits wait five idle seconds and only validate the latest value", async () => {
  const clock = fakeClock();
  const requests: string[] = [];
  const states: WorkflowValidationState[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    now: clock.now,
    validate: async (semantic) => {
      requests.push(semantic);
      return valid;
    },
    onState: (state) => states.push(state),
  });

  controller.schedule("first");
  clock.advance(1_000);
  controller.schedule("second");

  assert.deepEqual(states, []);
  assert.deepEqual(clock.delays, [5_000, 5_000]);
  assert.equal(clock.cancellations, 1);
  assert.deepEqual(requests, []);

  clock.fire();
  await flushPromises();

  assert.deepEqual(requests, ["second"]);
  assert.equal(
    (states as WorkflowValidationState[]).some(
      (state) => state.status === "checking",
    ),
    true,
  );
  assert.deepEqual(states.at(-1), {
    status: "valid",
    issues: [],
    nodeContracts: {},
    availableValuesByNode: {},
  });
});

test("a focused block pauses validation and deselection honors the remaining idle time", async () => {
  const clock = fakeClock();
  const requests: string[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    now: clock.now,
    validate: async (semantic) => {
      requests.push(semantic);
      return valid;
    },
    onState: () => undefined,
  });

  controller.setFocused(true);
  controller.schedule("draft");
  assert.equal(clock.pending, false);

  clock.advance(3_000);
  controller.setFocused(false);
  assert.deepEqual(clock.delays, [2_000]);
  clock.fire();
  await flushPromises();
  assert.deepEqual(requests, ["draft"]);
});

test("deselecting after the idle deadline validates immediately", async () => {
  const clock = fakeClock();
  const requests: string[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    now: clock.now,
    validate: async (semantic) => {
      requests.push(semantic);
      return valid;
    },
    onState: () => undefined,
  });

  controller.setFocused(true);
  controller.schedule("draft");
  clock.advance(5_100);
  controller.setFocused(false);

  assert.deepEqual(clock.delays, [0]);
  clock.fire();
  await flushPromises();
  assert.deepEqual(requests, ["draft"]);
});

test("focusing a block aborts an in-flight background request and retries after deselection", async () => {
  const clock = fakeClock();
  const requests: Array<{ value: string; signal: AbortSignal }> = [];
  const first = deferred<WorkflowDefinitionValidationResponse>();
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    now: clock.now,
    validate: async (value, signal) => {
      requests.push({ value, signal });
      if (requests.length === 1) return first.promise;
      return valid;
    },
    onState: () => undefined,
  });

  controller.schedule("draft");
  clock.advance(5_000);
  clock.fire();
  assert.equal(requests[0]?.signal.aborted, false);

  controller.setFocused(true);
  assert.equal(requests[0]?.signal.aborted, true);
  controller.setFocused(false);
  assert.deepEqual(clock.delays, [5_000, 0]);

  clock.fire();
  await flushPromises();
  assert.equal(requests.length, 2);
  first.resolve(invalid);
  await flushPromises();
});

test("validateNow cancels debounce and runs while a block is focused", async () => {
  const clock = fakeClock();
  const requests: string[] = [];
  const states: WorkflowValidationState[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    now: clock.now,
    validate: async (semantic) => {
      requests.push(semantic);
      return invalid;
    },
    onState: (state) => states.push(state),
  });

  controller.setFocused(true);
  controller.schedule("background");
  const result = await controller.validateNow("save");

  assert.equal(clock.pending, false);
  assert.deepEqual(requests, ["save"]);
  assert.equal(result.valid, false);
  assert.deepEqual(states.at(-1), {
    status: "invalid",
    issues: invalid.issues,
    nodeContracts: {},
    availableValuesByNode: {},
  });
});

test("a newer edit aborts immediate validation and prevents its stale state", async () => {
  const clock = fakeClock();
  const first = deferred<WorkflowDefinitionValidationResponse>();
  const signals: AbortSignal[] = [];
  const states: WorkflowValidationState[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    now: clock.now,
    validate: async (_semantic, signal) => {
      signals.push(signal);
      return first.promise;
    },
    onState: (state) => states.push(state),
  });

  const immediate = controller.validateNow("save");
  controller.schedule("newer edit");
  assert.equal(signals[0]?.aborted, true);

  first.resolve(invalid);
  await assert.rejects(immediate, { name: "AbortError" });
  assert.equal(states.some((state) => state.status === "error"), false);
});

test("an older response cannot overwrite the latest validation result", async () => {
  const clock = fakeClock();
  const first = deferred<WorkflowDefinitionValidationResponse>();
  const second = deferred<WorkflowDefinitionValidationResponse>();
  const responses = [first, second];
  const states: WorkflowValidationState[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    now: clock.now,
    validate: async () => responses.shift()!.promise,
    onState: (state) => states.push(state),
  });

  controller.schedule("first");
  clock.fire();
  controller.schedule("second");
  clock.fire();

  second.resolve(valid);
  await flushPromises();
  first.resolve(invalid);
  await flushPromises();

  assert.deepEqual(states.at(-1), {
    status: "valid",
    issues: [],
    nodeContracts: {},
    availableValuesByNode: {},
  });
  assert.equal(states.some((state) => state.status === "invalid"), false);
});

test("network failures become workflow-level validation errors", async () => {
  const clock = fakeClock();
  const states: WorkflowValidationState[] = [];
  const controller = createWorkflowValidationController<string>({
    timer: clock.timer,
    now: clock.now,
    validate: async () => {
      throw new Error("Validation service unavailable");
    },
    onState: (state) => states.push(state),
  });

  controller.schedule("draft");
  clock.fire();
  await flushPromises();

  assert.deepEqual(states.at(-1), {
    status: "error",
    issues: [
      {
        code: "deployment",
        severity: "error",
        nodeId: null,
        message: "Validation service unavailable",
      },
    ],
    nodeContracts: {},
    availableValuesByNode: {},
  });
});

test("same-snapshot immediate validation retains completed issues while checking", async () => {
  const first = deferred<WorkflowDefinitionValidationResponse>();
  const responses = [Promise.resolve(invalid), first.promise];
  const states: WorkflowValidationState[] = [];
  const controller = createWorkflowValidationController<string>({
    validate: async () => responses.shift()!,
    onState: (state) => states.push(state),
  });

  await controller.validateNow("draft");
  const revalidation = controller.validateNow("draft");

  assert.deepEqual(states.at(-1), {
    status: "checking",
    issues: invalid.issues,
    nodeContracts: {},
    availableValuesByNode: {},
  });

  first.resolve(valid);
  await revalidation;
  assert.equal(states.at(-1)?.status, "valid");
});

test("immediate transport failures restore the last completed state", async () => {
  const states: WorkflowValidationState[] = [];
  let fail = false;
  const controller = createWorkflowValidationController<string>({
    validate: async () => {
      if (fail) throw new Error("offline");
      return invalid;
    },
    onState: (state) => states.push(state),
  });

  await controller.validateNow("draft");
  fail = true;
  await assert.rejects(controller.validateNow("draft"), /offline/);

  assert.deepEqual(states.at(-1), {
    status: "invalid",
    issues: invalid.issues,
    nodeContracts: {},
    availableValuesByNode: {},
  });
});
