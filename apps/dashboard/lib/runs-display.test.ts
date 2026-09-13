import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRunStatusFilter,
  runIdentity,
  runStatusHref,
} from "./runs-display";

test("run status filters parse strictly and remain shareable in the URL", () => {
  assert.equal(parseRunStatusFilter("failed"), "failed");
  assert.equal(parseRunStatusFilter("FAILED"), "all");
  assert.equal(parseRunStatusFilter(undefined), "all");
  assert.equal(
    runStatusHref({ status: "failed", window: "24h", q: "broken build" }),
    "/runs?q=broken+build&status=failed",
  );
  assert.equal(
    runStatusHref({ status: "failed", window: "24h", q: "" }),
    "/runs?status=failed",
  );
  assert.equal(
    runStatusHref({ status: "all", window: "7d", q: "" }),
    "/runs?window=7d",
  );
  assert.equal(runStatusHref({ status: "all", window: "24h", q: "" }), "/runs");
});

test("run identity never repeats a fallback ticket and uses the run id without a ticket", () => {
  assert.deepEqual(
    runIdentity({ id: "run_1", ticket: "AIW-7", ticketTitle: "AIW-7" }),
    { primary: "AIW-7", showTicketLink: false, showRunIdMeta: true },
  );
  assert.deepEqual(
    runIdentity({ id: "run_2", ticket: "", ticketTitle: "" }),
    { primary: "run_2", showTicketLink: false, showRunIdMeta: false },
  );
});
