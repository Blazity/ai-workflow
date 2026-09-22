import { INTEGRATION_PROVIDER_WAIT_MS } from "@shared/contracts";

/**
 * How long the dashboard waits on a worker call that itself waits on a
 * provider: saving and testing a connection, and reading a contributed page.
 *
 * Derived from the worker's own budget, never written as a second number. It
 * sits above that budget by the time the worker needs around the provider call
 * (its session check, reading the connection, writing down what the provider
 * said), so the answer a person reads is always the worker's: the provider's
 * data, or the worker saying the provider did not answer. Below it, a slow but
 * healthy provider was reported as our outage, and a token that worked was
 * rotated for nothing.
 */
export const PROVIDER_CALL_CEILING_MS = INTEGRATION_PROVIDER_WAIT_MS + 10_000;
