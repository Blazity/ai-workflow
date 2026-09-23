import assert from "node:assert/strict";
import test from "node:test";

import { readReplayLogs } from "./replay-logs";
import { STORED_LOGS, STORED_LOG_EVENTS } from "./test-support/replay-logs";

test("each stored log reads as its stream and its events, parsed", () => {
  const logs = readReplayLogs(STORED_LOGS);
  assert.ok(logs);
  assert.deepEqual(logs.map((entry) => entry.stream), ["stdout", "stdout"]);
  assert.deepEqual(logs[0]!.lines, [{ kind: "json", value: STORED_LOG_EVENTS.credit }]);
});

test("a JSON document inside a field is read as the document, not as an escaped string", () => {
  const logs = readReplayLogs(STORED_LOGS)!;
  const line = logs[1]!.lines[0]!;
  assert.equal(line.kind, "json");
  const result = (line.kind === "json" ? line.value : null) as { result: { plan: string } };
  assert.equal(result.result.plan, STORED_LOG_EVENTS.plan);
});

test("plain text stays text, a progress line and a cut-off capture alike", () => {
  const progress = "Checks running: about 2m of 10m, 3 commands launched, blazity/app";
  assert.deepEqual(readReplayLogs(progress), [
    { stream: null, lines: [{ kind: "text", text: progress }] },
  ]);
  // A log set over the size budget is stored as the tail of its own JSON, cut
  // mid-document behind a marker: nothing in it parses, and it is shown as is.
  const cut = '[TRUNCATED]\n"stream":"stderr"},{"tail":"npm ERR! code E401\\nnpm ERR! Unable';
  assert.deepEqual(readReplayLogs(cut), [{ stream: null, lines: [{ kind: "text", text: cut }] }]);
});

test("a single log object, and text lines between events, keep their order", () => {
  const logs = readReplayLogs({
    stream: "stderr",
    tail: 'warning: retrying\n{"type":"system","ok":true}\nlast line',
  });
  assert.deepEqual(logs, [
    {
      stream: "stderr",
      lines: [
        { kind: "text", text: "warning: retrying" },
        { kind: "json", value: { type: "system", ok: true } },
        { kind: "text", text: "last line" },
      ],
    },
  ]);
});

test("nothing to show is null, so the raw view stays the fallback", () => {
  assert.equal(readReplayLogs(null), null);
  assert.equal(readReplayLogs([]), null);
});
