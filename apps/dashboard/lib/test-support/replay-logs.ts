import type { JsonValue } from "@shared/contracts";

// The shape a real attempt stored on production (run wrun_01M3755BR7PYPCZ7VVSJ7RGM88,
// trimmed): each log is the agent CLI's stdout tail, and that tail is one JSON
// event per line, whose `result` is sometimes itself a JSON document. Shown as
// JSON.stringify of the whole value, that is three layers of backslashes.
const creditEvent = {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 400,
  num_turns: 1,
  result: "Credit balance is too low",
  usage: { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 0 } },
  terminal_reason: "api_error",
};
const plan =
  "## Add `formatMoneyPl` to src/pricing/format.ts\n\n1. Add a new exported function.\n```ts\nconst SUFFIX: Record<Money[\"currency\"], string> = {\n  PLN: \"zł\",\n};\n```";
const planEvent = {
  type: "result",
  is_error: false,
  num_turns: 22,
  result: JSON.stringify({ status: "completed", plan }),
};
export const STORED_LOG_EVENTS = { credit: creditEvent, plan };

export const STORED_LOGS: JsonValue = [
  { tail: JSON.stringify(creditEvent), stream: "stdout" },
  { tail: `${JSON.stringify(planEvent)}\n`, stream: "stdout" },
];
