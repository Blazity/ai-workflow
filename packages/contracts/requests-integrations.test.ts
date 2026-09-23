import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRequestBody } from "./request-parsing";
import {
  integrationConnectionSaveRequestSchema,
  integrationEnabledRequestSchema,
  integrationSourceRequestSchema,
} from "./requests-integrations";

describe("integrationConnectionSaveRequestSchema", () => {
  it("refuses a body that does not say which of the three it is", () => {
    // The command used to be inferred, and a write was what an absent one
    // meant. A preview that lost this field between the browser and the route
    // would then have carried out the very change it was asking about.
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, {
      expectedVersion: 3,
      values: { channelId: "C1" },
    });

    assert.equal(parsed.ok, false);
  });

  it("accepts a first connect, which carries no stored version", () => {
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, {
      preview: "write",
      expectedVersion: 0,
      values: { baseUrl: "https://fixture.example", apiToken: "token" },
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.value.clearSecrets, []);
  });

  it("accepts a save that corrects one field and leaves the secret alone", () => {
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, {
      preview: "write",
      expectedVersion: 3,
      values: { baseUrl: "https://fixture.example/fixed" },
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.value.values, {
      baseUrl: "https://fixture.example/fixed",
    });
  });

  it("refuses a body with no version, because a save without one cannot detect a second tab", () => {
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, { preview: "write", values: {} });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.message, "expectedVersion must be a number");
  });

  it("refuses a negative version", () => {
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, {
      preview: "write",
      expectedVersion: -1,
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.message, "expectedVersion must not be negative");
  });

  it("refuses a value no credential could be, so a body cannot carry a file", () => {
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, {
      preview: "write",
      expectedVersion: 0,
      values: { privateKey: "x".repeat(8193) },
    });
    assert.equal(parsed.ok, false);
    assert.equal(
      parsed.ok === false && parsed.message,
      "a connection value must be 8192 characters or fewer",
    );
  });

  it("accepts a PEM-sized value, because a private key is a connection field", () => {
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, {
      preview: "write",
      expectedVersion: 0,
      values: { privateKey: "x".repeat(8192) },
    });
    assert.equal(parsed.ok, true);
  });
});

describe("integrationSourceRequestSchema", () => {
  it("accepts the two sources a connection can have", () => {
    for (const source of ["environment", "stored"]) {
      assert.equal(parseRequestBody(integrationSourceRequestSchema, { source }).ok, true);
    }
  });

  it("refuses anything else, naming both", () => {
    const parsed = parseRequestBody(integrationSourceRequestSchema, { source: "both" });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.message, "source must be environment or stored");
  });
});

describe("integrationEnabledRequestSchema", () => {
  it("refuses a missing switch rather than guessing which way it went", () => {
    const parsed = parseRequestBody(integrationEnabledRequestSchema, {});
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.message, "enabled must be true or false");
  });
});

describe("integrationImpactPreviewRequestSchema", () => {
  it("previews a switch of source, naming the source it would switch to", () => {
    // Decision 9: impact before a switch of source. The switch moves the pin
    // whenever the two sources hold different values, so it is asked first.
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, {
      preview: "source",
      source: "stored",
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.value, { preview: "source", source: "stored" });
  });

  it("refuses a source preview that does not say which source", () => {
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, { preview: "source" });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.message, "source must be environment or stored");
  });

  it("previews the kill switch", () => {
    const parsed = parseRequestBody(integrationConnectionSaveRequestSchema, { preview: "disable" });
    assert.equal(parsed.ok, true);
  });
});
