import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  manualDispatchInputSchema,
  manualDispatchRequestSchema,
  parseRequestBody,
  schedulePreviewRequestSchema,
  webhookRotateSecretRequestSchema,
  webhookSetSecretBodySchema,
  webhookTestDeliveryRequestSchema,
} from "@shared/contracts";

describe("webhook bodies", () => {
  it("takes force as it comes, so a non-boolean is not a refusal", () => {
    expect(parseRequestBody(webhookRotateSecretRequestSchema, { force: "yes" })).toEqual({
      ok: true,
      value: { force: "yes" },
    });
    expect(parseRequestBody(webhookRotateSecretRequestSchema, {})).toEqual({
      ok: true,
      value: {},
    });
  });

  it("takes a secret of any type, leaving the store to judge it", () => {
    expect(parseRequestBody(webhookSetSecretBodySchema, { secret: 12 })).toEqual({
      ok: true,
      value: { secret: 12 },
    });
  });

  it("drops an unknown field from a rotate body", () => {
    expect(
      parseRequestBody(webhookRotateSecretRequestSchema, { force: true, why: "leak" }),
    ).toEqual({ ok: true, value: { force: true } });
  });

  it("requires the payload key on a test delivery, null value included", () => {
    expect(
      parseRequestBody(webhookTestDeliveryRequestSchema, { payload: null }),
    ).toEqual({ ok: true, value: { payload: null } });
    expect(parseRequestBody(webhookTestDeliveryRequestSchema, {})).toEqual({
      ok: false,
      message: "payload is required",
    });
    expect(parseRequestBody(webhookTestDeliveryRequestSchema, null)).toEqual({
      ok: false,
      message: "payload is required",
    });
  });
});

describe("schedulePreviewRequestSchema", () => {
  it("accepts a cron request", () => {
    const body = { source: "cron", cron: "0 9 * * *", timezone: "Europe/Warsaw" };
    expect(parseRequestBody(schedulePreviewRequestSchema, body)).toEqual({
      ok: true,
      value: body,
    });
  });

  it("accepts a preset request", () => {
    const body = {
      source: "preset",
      preset: { kind: "weekly", weekdays: [1, 3], hour: 9, minute: 0 },
      timezone: "UTC",
    };
    expect(parseRequestBody(schedulePreviewRequestSchema, body)).toEqual({
      ok: true,
      value: body,
    });
  });

  it("refuses a body that is not an object", () => {
    expect(parseRequestBody(schedulePreviewRequestSchema, null)).toEqual({
      ok: false,
      message: "Invalid preview request",
    });
  });

  it("asks for the timezone before it looks at the source", () => {
    expect(parseRequestBody(schedulePreviewRequestSchema, { source: "cron" })).toEqual({
      ok: false,
      message: "timezone is required",
    });
  });

  it("refuses an empty cron", () => {
    expect(
      parseRequestBody(schedulePreviewRequestSchema, {
        source: "cron",
        cron: "  ",
        timezone: "UTC",
      }),
    ).toEqual({ ok: false, message: "cron is required" });
  });

  it("refuses a preset whose numbers are not numbers", () => {
    expect(
      parseRequestBody(schedulePreviewRequestSchema, {
        source: "preset",
        preset: { kind: "daily", hour: "9", minute: 0 },
        timezone: "UTC",
      }),
    ).toEqual({ ok: false, message: "Invalid schedule preset" });
  });

  it("refuses an unknown source", () => {
    expect(
      parseRequestBody(schedulePreviewRequestSchema, { source: "rrule", timezone: "UTC" }),
    ).toEqual({ ok: false, message: 'source must be "cron" or "preset"' });
  });

  it("leaves an unknown field in place, since the body is forwarded whole", () => {
    const body = { source: "cron", cron: "* * * * *", timezone: "UTC", extra: 1 };
    const parsed = parseRequestBody(schedulePreviewRequestSchema, body);
    expect(parsed).toEqual({ ok: true, value: body });
  });
});

describe("manualDispatchInputSchema", () => {
  it("accepts a ticket input and trims the key", () => {
    expect(parseRequestBody(manualDispatchInputSchema, { kind: "ticket", ticketKey: " AIW-1 " })).toEqual({
      ok: true,
      value: { kind: "ticket", ticketKey: "AIW-1" },
    });
  });

  it("accepts a pull request input and trims the url", () => {
    expect(
      parseRequestBody(manualDispatchInputSchema, {
        kind: "pull_request",
        url: " https://github.com/a/b/pull/1 ",
      }),
    ).toEqual({
      ok: true,
      value: { kind: "pull_request", url: "https://github.com/a/b/pull/1" },
    });
  });

  it("refuses a missing identifier with the one message the handler used", () => {
    expect(parseRequestBody(manualDispatchInputSchema, { kind: "ticket" })).toEqual({
      ok: false,
      message: "Invalid dispatch input",
    });
  });

  it("refuses an identifier of the wrong type", () => {
    expect(parseRequestBody(manualDispatchInputSchema, { kind: "ticket", ticketKey: 7 })).toEqual({
      ok: false,
      message: "Invalid dispatch input",
    });
  });

  it("refuses a whitespace-only key, an unknown kind and a body that is not an object", () => {
    for (const body of [
      { kind: "ticket", ticketKey: "   " },
      { kind: "epic", ticketKey: "AIW-1" },
      null,
      "AIW-1",
    ]) {
      expect(parseRequestBody(manualDispatchInputSchema, body)).toEqual({
        ok: false,
        message: "Invalid dispatch input",
      });
    }
  });

  it("drops a key that belongs to the other kind, as the handler rebuilt the value", () => {
    expect(
      parseRequestBody(manualDispatchInputSchema, {
        kind: "ticket",
        ticketKey: "AIW-1",
        url: "https://example.test/pull/1",
      }),
    ).toEqual({ ok: true, value: { kind: "ticket", ticketKey: "AIW-1" } });
  });
});

describe("manualDispatchRequestSchema", () => {
  const REQUEST_ID = "6f1c1d5e-0f24-4a0b-9b6f-3f5c1d2e4a7b";

  it("accepts an envelope carrying a dispatch input", () => {
    expect(
      parseRequestBody(manualDispatchRequestSchema, {
        requestId: REQUEST_ID,
        expectedDeployedVersion: 3,
        input: { kind: "ticket", ticketKey: "AIW-1" },
      }),
    ).toEqual({
      ok: true,
      value: {
        requestId: REQUEST_ID,
        expectedDeployedVersion: 3,
        input: { kind: "ticket", ticketKey: "AIW-1" },
      },
    });
  });

  it("refuses a request id that is not a uuid", () => {
    expect(
      parseRequestBody(manualDispatchRequestSchema, {
        requestId: "not-a-uuid",
        expectedDeployedVersion: 3,
        input: { kind: "ticket", ticketKey: "AIW-1" },
      }),
    ).toEqual({ ok: false, message: "Invalid dispatch request" });
  });

  it("refuses a deployed version that is missing, fractional or not positive", () => {
    for (const expectedDeployedVersion of [undefined, 1.5, 0, "3"]) {
      expect(
        parseRequestBody(manualDispatchRequestSchema, {
          requestId: REQUEST_ID,
          expectedDeployedVersion,
          input: { kind: "ticket", ticketKey: "AIW-1" },
        }),
      ).toEqual({ ok: false, message: "Invalid dispatch request" });
    }
  });

  it("answers about the envelope before the input, as the handler checked in that order", () => {
    expect(
      parseRequestBody(manualDispatchRequestSchema, {
        requestId: "not-a-uuid",
        expectedDeployedVersion: 3,
        input: { kind: "epic" },
      }),
    ).toEqual({ ok: false, message: "Invalid dispatch request" });
  });

  it("reports a bad input with the input message once the envelope is sound", () => {
    expect(
      parseRequestBody(manualDispatchRequestSchema, {
        requestId: REQUEST_ID,
        expectedDeployedVersion: 3,
        input: { kind: "epic" },
      }),
    ).toEqual({ ok: false, message: "Invalid dispatch input" });
  });

  it("drops an unknown field and refuses a body that is not an object", () => {
    expect(
      parseRequestBody(manualDispatchRequestSchema, {
        requestId: REQUEST_ID,
        expectedDeployedVersion: 3,
        input: { kind: "ticket", ticketKey: "AIW-1" },
        note: "ignored",
      }),
    ).toEqual({
      ok: true,
      value: {
        requestId: REQUEST_ID,
        expectedDeployedVersion: 3,
        input: { kind: "ticket", ticketKey: "AIW-1" },
      },
    });
    expect(parseRequestBody(manualDispatchRequestSchema, null)).toEqual({
      ok: false,
      message: "Invalid dispatch request",
    });
  });
});
