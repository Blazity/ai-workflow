export interface ListboxState {
  open: boolean;
  activeIdx: number;
}

export type ListboxEvent =
  | { type: "toggle"; selectedIdx: number }
  | { type: "open"; selectedIdx: number }
  | { type: "close" }
  | { type: "move"; delta: 1 | -1; count: number }
  | { type: "activate"; idx: number }
  | { type: "commit" };

function clamp(idx: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, idx));
}

export function listboxReducer(state: ListboxState, event: ListboxEvent): ListboxState {
  switch (event.type) {
    case "toggle":
      return state.open
        ? { ...state, open: false }
        : { open: true, activeIdx: Math.max(0, event.selectedIdx) };
    case "open":
      return { open: true, activeIdx: Math.max(0, event.selectedIdx) };
    case "close":
      return { ...state, open: false };
    case "move":
      return { ...state, activeIdx: clamp(state.activeIdx + event.delta, event.count) };
    case "activate":
      return { ...state, activeIdx: Math.max(0, event.idx) };
    case "commit":
      return { ...state, open: false };
  }
}

export function keyToEvent(
  key: string,
  state: ListboxState,
  count: number,
  selectedIdx: number,
): ListboxEvent | null {
  switch (key) {
    case "ArrowDown":
      return state.open ? { type: "move", delta: 1, count } : { type: "open", selectedIdx };
    case "ArrowUp":
      return state.open ? { type: "move", delta: -1, count } : { type: "open", selectedIdx };
    case "Enter":
    case " ":
      return state.open ? { type: "commit" } : { type: "open", selectedIdx };
    case "Escape":
      return state.open ? { type: "close" } : null;
    case "Tab":
      return state.open ? { type: "close" } : null;
    default:
      return null;
  }
}
