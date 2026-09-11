/**
 * Domain failures of a prompt library write, as something a transport can map.
 *
 * The store raises PromptLibraryStoreError for the refusals that are about the
 * prompt rather than about permission (400 invalid, 404 missing, 409 conflict).
 * Recognising it here keeps the store class below the app tier while the caller
 * still answers with the same status and message it always did.
 */
import { PromptLibraryStoreError } from "../../prompt-library/store.js";

export interface PromptLibraryFailure {
  statusCode: number;
  message: string;
}

/** The failure a prompt library write reported, or null for anything else. */
export function promptLibraryFailure(error: unknown): PromptLibraryFailure | null {
  return error instanceof PromptLibraryStoreError
    ? { statusCode: error.statusCode, message: error.message }
    : null;
}
