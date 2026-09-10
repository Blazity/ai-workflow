import { describe, expect, it } from "vitest";
import { parseRequestBody, resendWebhookEventSchema } from "@shared/contracts";

describe("resendWebhookEventSchema", () => {
  it("accepts a delivery event with the fields the ledger reads", () => {
    const body = {
      type: "email.bounced",
      data: {
        email_id: "re_1",
        tags: { inviteId: "inv_1" },
        bounce: { message: "mailbox full", type: "Transient", subType: "General" },
      },
    };
    expect(parseRequestBody(resendWebhookEventSchema, body)).toEqual({
      ok: true,
      value: body,
    });
  });

  it("accepts an empty object, because every field is optional", () => {
    expect(parseRequestBody(resendWebhookEventSchema, {})).toEqual({
      ok: true,
      value: {},
    });
  });

  it("refuses a field of the wrong type", () => {
    const parsed = parseRequestBody(resendWebhookEventSchema, { type: 3 });
    expect(parsed.ok).toBe(false);
  });

  it("keeps unknown fields, because Resend adds them without warning", () => {
    const body = {
      type: "email.sent",
      created_at: "2026-09-11T00:00:00.000Z",
      data: { email_id: "re_2", to: ["a@example.com"] },
    };
    expect(parseRequestBody(resendWebhookEventSchema, body)).toEqual({
      ok: true,
      value: body,
    });
  });
});
