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

  it("refuses an envelope field of the wrong type", () => {
    // The three fields the ledger reads as strings are the whole of what this
    // schema polices: a numeric event name is not an event it can map.
    expect(parseRequestBody(resendWebhookEventSchema, { type: 3 }).ok).toBe(false);
    expect(
      parseRequestBody(resendWebhookEventSchema, { type: "email.sent", data: 7 }).ok,
    ).toBe(false);
    expect(
      parseRequestBody(resendWebhookEventSchema, {
        type: "email.sent",
        data: { email_id: 7 },
      }).ok,
    ).toBe(false);
  });
});

describe("resendWebhookEventSchema and the leaves below data", () => {
  it("passes a leaf of any shape through, because the mapper reads it defensively", () => {
    // The three shapes that used to be dropped: Resend sends them, the signature
    // over them held, and the ledger has to see them.
    const numericSubType = {
      type: "email.bounced",
      data: { email_id: "re_3", bounce: { message: "mailbox full", subType: 4 } },
    };
    const arrayTags = {
      type: "email.bounced",
      data: { email_id: "re_4", tags: ["invite"] },
    };
    const nullTagValue = {
      type: "email.delivered",
      data: { email_id: "re_5", tags: { invite_delivery_id: null } },
    };
    for (const body of [numericSubType, arrayTags, nullTagValue]) {
      expect(parseRequestBody(resendWebhookEventSchema, body)).toEqual({
        ok: true,
        value: body,
      });
    }
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
