import { useEffect, useRef, type MutableRefObject } from "react";
import {
  createWorkflowValidationController,
  type WorkflowValidationController,
  type WorkflowValidationControllerOptions,
} from "./validation-controller";

export function useWorkflowValidationController<T>(
  options: WorkflowValidationControllerOptions<T>,
): MutableRefObject<WorkflowValidationController<T> | null> {
  const validateRef = useRef(options.validate);
  const onStateRef = useRef(options.onState);
  validateRef.current = options.validate;
  onStateRef.current = options.onState;
  const controllerRef =
    useRef<WorkflowValidationController<T> | null>(null);

  useEffect(() => {
    const controller = createWorkflowValidationController<T>({
      delayMs: options.delayMs,
      timer: options.timer,
      now: options.now,
      validate: (value, signal) => validateRef.current(value, signal),
      onState: (state) => onStateRef.current(state),
    });
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.dispose();
    };
  }, [options.delayMs, options.now, options.timer]);

  return controllerRef;
}
