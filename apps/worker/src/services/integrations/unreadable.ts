/**
 * The one answer for "this deployment's integration settings could not be
 * read", whoever was reading: the resolver that hands out contexts
 * (`usable.ts`) and the set of secrets core redacts with (`secret-values.ts`)
 * used to have a class each, and only one of them retried.
 */

/**
 * What a caller throws when it cannot do its work without this deployment's
 * integration settings and could not read them.
 *
 * A class rather than a sentence, because the caller that catches it is often
 * not the one that read (manual dispatch catches what the version control
 * runtime threw; a leak review catches what the secret set threw) and has to
 * answer "try again", never "not configured" and never "no secrets".
 *
 * The message is fixed apart from what could not be done, and the database's
 * own words ride in `cause`: the message lands where people read it (a run's
 * failure, a dispatch refusal, a ticket), and a driver's error text there
 * reads like a leak and helps nobody act. The reader logs the cause once,
 * where it read.
 */
export class IntegrationSettingsUnreadableError extends Error {
  constructor(
    /** What could not be done, as the end of a sentence: "so no sandbox was built". */
    consequence: string,
    cause: unknown,
  ) {
    super(
      `This deployment's integration settings could not be read, ${consequence}. Nothing is known about any provider from this; try again shortly.`,
      { cause },
    );
    this.name = "IntegrationSettingsUnreadableError";
  }
}

/** How long a failing read waits before its next attempt. Short: every caller
 *  is on a path somebody is waiting on (an MCP call, a step, a page, a
 *  webhook), and this exists to ride out a database blink, not an outage. */
const READ_RETRY_DELAYS_MS = [150, 450] as const;

/**
 * Read the integration tables, retried on the one rule above. Rethrows the
 * last error when every attempt failed; the caller decides what that means.
 */
export async function readIntegrationTables<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt - 1]);
      });
    }
    try {
      return await read();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
