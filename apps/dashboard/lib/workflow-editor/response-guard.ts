export interface EditorResponseGuard {
  capture(): number;
  invalidate(): void;
  isCurrent(revision: number): boolean;
}

/** Prevent an in-flight server response from replacing newer local edits. */
export function createEditorResponseGuard(): EditorResponseGuard {
  let revision = 0;
  return {
    capture: () => revision,
    invalidate: () => {
      revision += 1;
    },
    isCurrent: (candidate) => candidate === revision,
  };
}
