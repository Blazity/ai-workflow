export interface EditorHistoryTransaction<T> {
  before: T;
}

export interface EditorHistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  transaction: EditorHistoryTransaction<T> | null;
  savedSemanticKey: string | null;
  limit: number;
}

export type EditorHistoryAction<T> =
  | { type: "apply"; value: T }
  | { type: "begin_transaction" }
  | { type: "update_transaction"; value: T }
  | { type: "commit_transaction" }
  | { type: "cancel_transaction" }
  | { type: "undo" }
  | { type: "redo" }
  | {
      type: "reset";
      value: T;
      savedSemanticKey: string | null;
    }
  | { type: "mark_saved"; savedSemanticKey: string };

const DEFAULT_HISTORY_LIMIT = 100;

function valuesEqual<T>(left: T, right: T): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function appendPast<T>(
  past: readonly T[],
  value: T,
  limit: number,
): T[] {
  if (limit <= 0) return [];
  const retained = Math.max(0, limit - 1);
  return [...(retained === 0 ? [] : past.slice(-retained)), value];
}

export function createEditorHistory<T>(
  present: T,
  options: {
    savedSemanticKey?: string | null;
    limit?: number;
  } = {},
): EditorHistoryState<T> {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Editor history limit must be a positive integer.");
  }
  return {
    past: [],
    present,
    future: [],
    transaction: null,
    savedSemanticKey: options.savedSemanticKey ?? null,
    limit,
  };
}

export function reduceEditorHistory<T>(
  state: EditorHistoryState<T>,
  action: EditorHistoryAction<T>,
): EditorHistoryState<T> {
  switch (action.type) {
    case "apply": {
      if (valuesEqual(state.present, action.value)) return state;
      if (state.transaction) {
        return { ...state, present: action.value };
      }
      return {
        ...state,
        past: appendPast(state.past, state.present, state.limit),
        present: action.value,
        future: [],
      };
    }
    case "begin_transaction":
      return state.transaction
        ? state
        : { ...state, transaction: { before: state.present } };
    case "update_transaction": {
      if (!state.transaction) return state;
      if (valuesEqual(state.present, action.value)) return state;
      return { ...state, present: action.value };
    }
    case "commit_transaction": {
      if (!state.transaction) return state;
      if (valuesEqual(state.transaction.before, state.present)) {
        return { ...state, transaction: null };
      }
      return {
        ...state,
        past: appendPast(
          state.past,
          state.transaction.before,
          state.limit,
        ),
        future: [],
        transaction: null,
      };
    }
    case "cancel_transaction":
      return state.transaction
        ? {
            ...state,
            present: state.transaction.before,
            transaction: null,
          }
        : state;
    case "undo": {
      if (state.transaction || state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1]!;
      return {
        ...state,
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      };
    }
    case "redo": {
      if (state.transaction || state.future.length === 0) return state;
      const [next, ...future] = state.future;
      return {
        ...state,
        past: appendPast(state.past, state.present, state.limit),
        present: next!,
        future,
      };
    }
    case "reset":
      return createEditorHistory(action.value, {
        limit: state.limit,
        savedSemanticKey: action.savedSemanticKey,
      });
    case "mark_saved":
      return state.savedSemanticKey === action.savedSemanticKey
        ? state
        : { ...state, savedSemanticKey: action.savedSemanticKey };
  }
}

export function editorHistoryCanUndo<T>(
  state: EditorHistoryState<T>,
): boolean {
  return state.transaction === null && state.past.length > 0;
}

export function editorHistoryCanRedo<T>(
  state: EditorHistoryState<T>,
): boolean {
  return state.transaction === null && state.future.length > 0;
}

export function editorHistoryIsDirty<T>(
  state: EditorHistoryState<T>,
  currentSemanticKey: string,
): boolean {
  return (
    state.savedSemanticKey === null ||
    state.savedSemanticKey !== currentSemanticKey
  );
}

/**
 * Finish the transaction owned by a focused inspector field before a canvas
 * gesture takes ownership. Clearing the surface first makes its later blur a
 * no-op instead of accidentally committing the new canvas transaction.
 */
export function finishEditingSurfaceTransaction(options: {
  hasActiveSurface: () => boolean;
  clearActiveSurface: () => void;
  commitTransaction: () => void;
}): boolean {
  if (!options.hasActiveSurface()) return false;
  options.clearActiveSurface();
  options.commitTransaction();
  return true;
}
