import type { PromptSourceRef } from "@shared/contracts";

/** Payload a library insert hands to the prompt field: the text to place, an
 *  optional provenance ref (whole-prompt copies only), and whether it replaces
 *  the field or appends to it. The inserting UI is the library rail inside the
 *  prompt editor modal. */
export interface PromptInsertPayload {
  text: string;
  /** Set ONLY for whole-prompt Insert/Replace (via makePromptRef); null for
   *  append, section, and selection inserts. */
  ref: PromptSourceRef | null;
  mode: "replace" | "append";
}
