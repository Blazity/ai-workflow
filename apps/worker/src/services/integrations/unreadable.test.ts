/**
 * The one retry rule for reading the integration tables, and the one class
 * for giving up. Both readers use it: the resolver behind every context and
 * the secret set behind every redaction. Before, only the second retried, so a
 * database blink failed a dispatch that a leak review rode out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationSettingsUnreadableError, readIntegrationTables } from "./unreadable.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("readIntegrationTables", () => {
  it("rides out a blink: two failed reads, then the answer", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("reset"))
      .mockRejectedValueOnce(new Error("reset"))
      .mockResolvedValue("rows");

    const answer = readIntegrationTables(read);
    await vi.advanceTimersByTimeAsync(150 + 450);

    await expect(answer).resolves.toBe("rows");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up after the third failure with the last error, not an empty answer", async () => {
    vi.useFakeTimers();
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("down"));

    const answer = readIntegrationTables(read);
    const settled = expect(answer).rejects.toThrow("down");
    await vi.advanceTimersByTimeAsync(600);
    await settled;
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("IntegrationSettingsUnreadableError", () => {
  it("says what could not be done and keeps the driver's words out of the message", () => {
    const error = new IntegrationSettingsUnreadableError(
      "so the secrets they hold could not be redacted",
      new Error('Failed query: select "secrets" from "integration_connection_versions"'),
    );
    expect(error.message).toBe(
      "This deployment's integration settings could not be read, so the secrets they hold could not be redacted. Nothing is known about any provider from this; try again shortly.",
    );
    expect(error.message).not.toMatch(/Failed query|select/u);
    expect((error.cause as Error).message).toContain("Failed query");
  });
});
