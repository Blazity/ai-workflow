import assert from "node:assert/strict";
import { test } from "node:test";
import React, { StrictMode, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { WorkflowDefinitionValidationResponse } from "@shared/contracts";
import type {
  ValidationTimer,
} from "./validation-controller";
import { useWorkflowValidationController } from "./use-validation-controller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function fakeClock() {
  let callback: (() => void) | null = null;
  let nowMs = 0;
  const timer: ValidationTimer = (next) => {
    callback = next;
    return () => {
      if (callback === next) callback = null;
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
  };
}

test("Strict Mode recreates a usable controller after lifecycle replay", async () => {
  const clock = fakeClock();
  const requests: string[] = [];
  const valid: WorkflowDefinitionValidationResponse = {
    valid: true,
    issues: [],
    nodeContracts: {},
    availableValuesByNode: {},
  };

  function Harness({ focused }: { focused: boolean }) {
    const controller =
      useWorkflowValidationController<string>({
        timer: clock.timer,
        now: clock.now,
        validate: async (value) => {
          requests.push(value);
          return valid;
        },
        onState() {},
      });
    useEffect(() => controller.current?.schedule("draft"), [controller]);
    useEffect(
      () => controller.current?.setFocused(focused),
      [controller, focused],
    );
    return null;
  }

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Harness focused />
      </StrictMode>,
    );
  });
  clock.advance(5_000);
  await act(async () => {
    renderer.update(
      <StrictMode>
        <Harness focused={false} />
      </StrictMode>,
    );
  });
  await act(async () => clock.fire());

  assert.deepEqual(requests, ["draft"]);
  await act(async () => renderer.unmount());
});
