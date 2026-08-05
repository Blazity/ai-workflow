import { describe, expect, it } from "vitest";
import type { JsonValue } from "@shared/contracts";
import { mapWebhookPayload } from "./payload-mapping.js";

const registryDefaults = {
  mapSubject: "subject",
  mapDescription: "description",
  mapRequester: "requester",
  mapPriority: "priority",
};

describe("webhook payload mapping", () => {
  it("maps the registry default field names off a flat body", () => {
    const body = {
      subject: "Printer is on fire",
      description: "Smoke everywhere",
      requester: "ops@acme.test",
      priority: "urgent",
    };

    expect(mapWebhookPayload(registryDefaults, body)).toEqual({
      entry: { ...body, payload: body },
      subjectId: null,
    });
  });

  it("resolves nested paths and numeric array indexes", () => {
    const body = {
      ticket: { id: 4711, subject: "Nested", requester: { email: "a@b.test" } },
      tags: ["urgent", "billing"],
    };

    expect(
      mapWebhookPayload(
        {
          subjectPath: "ticket.id",
          mapSubject: "ticket.subject",
          mapRequester: "ticket.requester.email",
          mapPriority: "tags.0",
          mapDescription: "tags.5",
        },
        body,
      ),
    ).toEqual({
      entry: {
        subject: "Nested",
        description: "",
        requester: "a@b.test",
        priority: "urgent",
        payload: body,
      },
      subjectId: "4711",
    });
  });

  it("tolerates every shape a sender can produce instead of throwing", () => {
    const body = {
      subject: null,
      description: { rich: "text" },
      requester: 42,
      priority: false,
      nested: "not-an-object",
    };

    expect(
      mapWebhookPayload({ ...registryDefaults, subjectPath: "missing.path" }, body),
    ).toEqual({
      entry: {
        subject: "",
        description: "",
        requester: "42",
        priority: "false",
        payload: body,
      },
      subjectId: null,
    });
    expect(
      mapWebhookPayload({ mapSubject: "nested.deeper" }, body).entry.subject,
    ).toBe("");
    for (const shape of [null, "a string", 7, []]) {
      expect(mapWebhookPayload(registryDefaults, shape)).toEqual({
        entry: {
          subject: "",
          description: "",
          requester: "",
          priority: "",
          payload: shape,
        },
        subjectId: null,
      });
    }
  });

  it("refuses unsafe path segments the config validator would have rejected", () => {
    const body = JSON.parse('{"__proto__": {"id": "pwned"}, "ok": {"id": "fine"}}');

    expect(
      mapWebhookPayload({ subjectPath: "__proto__.id", mapSubject: "__proto__.id" }, body),
    ).toEqual({
      entry: {
        subject: "",
        description: "",
        requester: "",
        priority: "",
        payload: body,
      },
      subjectId: null,
    });
    expect(mapWebhookPayload({ subjectPath: "ok.id" }, body).subjectId).toBe("fine");
  });

  it("takes the subject id only from a non-empty scalar", () => {
    const cases: Array<[JsonValue, string | null]> = [
      [{ ticket: { id: "T-1" } }, "T-1"],
      [{ ticket: { id: "  T-2  " } }, "T-2"],
      [{ ticket: { id: 0 } }, "0"],
      [{ ticket: { id: "   " } }, null],
      [{ ticket: { id: null } }, null],
      [{ ticket: { id: { nested: true } } }, null],
      [{}, null],
    ];
    for (const [body, expected] of cases) {
      expect(mapWebhookPayload({ subjectPath: "ticket.id" }, body).subjectId).toBe(
        expected,
      );
    }
  });
});
