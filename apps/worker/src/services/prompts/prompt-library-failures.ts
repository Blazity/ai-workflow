/**
 * Domain failures of a prompt library write, as something a transport can map.
 *
 * The store raises PromptLibraryStoreError for the refusals that are about the
 * prompt rather than about permission (400 invalid, 404 missing, 409 conflict).
 * Recognising it here keeps the store class below the app tier while the caller
 * still answers with the same status and message it always did.
 */
export class PromptLibraryStoreError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export class PromptLibraryCasMissError extends PromptLibraryStoreError {
  readonly kind = "prompt_library.cas_miss" as const;

  constructor(
    public readonly promptId: number,
    public readonly expectedVersion: number,
    public readonly currentVersion: number | null,
  ) {
    super(409, currentVersion === null
      ? `Prompt ${promptId} has no current version`
      : `Prompt ${promptId} is at version ${currentVersion}, not ${expectedVersion}. Read it again with prompts.get and re-send the edit against the version you have seen.`);
  }
}

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
