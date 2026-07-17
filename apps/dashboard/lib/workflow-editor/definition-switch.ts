export type DefinitionSwitchState =
  | { kind: "idle" }
  | { kind: "confirming"; targetId: number };

export type DefinitionSwitchEvent =
  | { type: "request"; targetId: number; dirty: boolean }
  | { type: "confirm" }
  | { type: "cancel" };

export interface DefinitionSwitchTransition {
  state: DefinitionSwitchState;
  switchTo: number | null;
}

export function reduceDefinitionSwitch(
  state: DefinitionSwitchState,
  event: DefinitionSwitchEvent,
): DefinitionSwitchTransition {
  if (event.type === "request") {
    if (event.dirty) {
      return { state: { kind: "confirming", targetId: event.targetId }, switchTo: null };
    }
    return { state: { kind: "idle" }, switchTo: event.targetId };
  }
  if (event.type === "confirm" && state.kind === "confirming") {
    return { state: { kind: "idle" }, switchTo: state.targetId };
  }
  return { state: { kind: "idle" }, switchTo: null };
}
