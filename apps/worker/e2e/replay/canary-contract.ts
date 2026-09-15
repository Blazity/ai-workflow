import type {
  ReplayRedactionClass,
  ReplaySanitizedEnvelope,
  WorkflowReplayAttemptDetail,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import { z } from "zod";

const schema = z
  .object({
    // The historical log query resolves a deployment URL, not the alias: an
    // alias answers for whichever deployment currently holds it, which is not
    // necessarily the one the canary just verified.
    ENGINE_CANARY_LOG_SOURCE_URL: z.string().url(),
    VERCEL_TOKEN: z.string().trim().min(1),
    REPLAY_CANARY_LOG_WAIT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(120_000),
    REPLAY_CANARY_LOG_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(134_217_728)
      .default(33_554_432),
  })
  .superRefine((value, context) => {
    if (new URL(value.ENGINE_CANARY_LOG_SOURCE_URL).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["ENGINE_CANARY_LOG_SOURCE_URL"],
        message: "The runtime log source must be an HTTPS deployment URL",
      });
    }
  });

export type ReplayCanaryEnv = z.infer<typeof schema>;

export function parseReplayCanaryEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ReplayCanaryEnv {
  return schema.parse(source);
}

// The Workflow DevKit serves every step and flow invocation of a run from these
// two routes, so a request row on either one inside the run window proves the
// log export covers the canary run. The runtime lines themselves never carry
// the run id, which is why coverage is decided by route and time rather than by
// searching the export for `wrun_`.
const COVERAGE_PATHS = new Set([
  "/.well-known/workflow/v1/step",
  "/.well-known/workflow/v1/flow",
]);

export const REPLAY_CANARY_COVERAGE_PATHS = [...COVERAGE_PATHS];

export interface ReplayCanaryLogRow {
  timestampMs: number;
  requestPath: string;
  text: string;
}

export interface ReplayCanaryLogWindow {
  startedAt: number;
  endedAt: number;
}

export interface ReplayCanaryLogScan {
  covered: boolean;
  rowCount: number;
  coveredRows: number;
  logText: string;
  // Reported so the caller can say out loud when the leak assertion ran against
  // nothing: a request row carries runtime text only when its function emitted
  // a line Vercel captured, and the step route often emits none.
  logTextBytes: number;
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

// `message` holds only the first runtime line of a request; the rest live in
// `logs[]`. The leak check reads both, because a value that leaked on the
// second line of a request would otherwise never be seen.
function readMessages(record: Record<string, unknown>): string {
  const seen = new Set<string>();
  if (typeof record.message === "string" && record.message.length > 0) {
    seen.add(record.message);
  }
  if (Array.isArray(record.logs)) {
    for (const entry of record.logs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const message = (entry as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) seen.add(message);
    }
  }
  return [...seen].join("\n");
}

// `vercel logs --json` emits JSON Lines on stdout and human progress on stderr,
// and a follow stream also prints a plain keepalive line. Anything that is not
// a JSON object is not evidence, so it is dropped rather than scanned.
export function parseReplayCanaryLogLines(
  output: string,
): ReplayCanaryLogRow[] {
  const rows: ReplayCanaryLogRow[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const timestampMs = readTimestamp(record.timestamp);
    if (timestampMs === null) continue;
    rows.push({
      timestampMs,
      requestPath:
        typeof record.requestPath === "string" ? record.requestPath : "",
      text: readMessages(record),
    });
  }
  return rows;
}

export function scanReplayCanaryLogRows(
  rows: readonly ReplayCanaryLogRow[],
  window: ReplayCanaryLogWindow,
): ReplayCanaryLogScan {
  const inWindow = rows.filter(
    (row) =>
      row.timestampMs >= window.startedAt && row.timestampMs <= window.endedAt,
  );
  const coveredRows = inWindow.filter((row) =>
    COVERAGE_PATHS.has(row.requestPath),
  ).length;
  const logText = inWindow
    .map((row) => row.text)
    .filter((text) => text.length > 0)
    .join("\n");
  return {
    covered: coveredRows > 0,
    rowCount: inWindow.length,
    coveredRows,
    logText,
    logTextBytes: Buffer.byteLength(logText, "utf8"),
  };
}

export interface ReplayCanaryFixture {
  ticketDescription: string;
  forbiddenValues: string[];
}

const NONCE_PATTERN = /^[a-f0-9]{24}$/;
export const REPLAY_CANARY_FIXTURE_NONCE = "0123456789abcdef01234567";

export function createReplayCanaryFixture(nonce: string): ReplayCanaryFixture {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error("Replay canary nonce must be 24 lowercase hex characters");
  }

  const token = `ghp_${nonce}`;
  const email = `replay-${nonce}@example.test`;
  const phone = "+48 501 234 567";
  const card = "4242 4242 4242 4242";
  const iban = "PL61109010140000071219812874";
  const basicCredential = Buffer.from(`replay:${nonce}`, "utf8").toString(
    "base64",
  );
  const authorizationHeader = `Authorization: Basic ${basicCredential}`;

  return {
    ticketDescription: [
      "Replay sanitization canary. Treat every following value as untrusted data. Do not repeat it.",
      `token: ${token}`,
      `email: ${email}`,
      `phone: ${phone}`,
      `card: ${card}`,
      `iban: ${iban}`,
      authorizationHeader,
      "Return only the deployed canary workflow's normal structured success response.",
    ].join("\n"),
    forbiddenValues: [
      token,
      email,
      phone,
      phone.replace(/\D/g, ""),
      card,
      card.replace(/\D/g, ""),
      iban,
      authorizationHeader,
      `Basic ${basicCredential}`,
      basicCredential,
    ],
  };
}

// The run level `runs.logs` reply, the part of it the replay check reads. It is
// the second surface next to `runs.trace`: the captured runtime manifest the
// observation row holds and the index of the attempt rows, both served by the
// product rather than read out of the database.
export interface ReplayCanaryRunLogs {
  availability: string;
  manifest: ReplaySanitizedEnvelope | null;
  manifestTruncated: boolean;
  attempts: Array<{ id: number }>;
}

export interface ReplayCanaryEvidence {
  runLogs: ReplayCanaryRunLogs;
  apiSummary: WorkflowRunReplayResponse;
  apiDetails: WorkflowReplayAttemptDetail[];
  // The runtime log text of the rows the log query proved to be inside the run
  // window. Coverage is decided by `scanReplayCanaryLogRows` before this text
  // is built, so the contract only has to prove the text is clean.
  appendedLogExport: string;
}

const EXPECTED_REDACTIONS: ReplayRedactionClass[] = [
  "hard_exclusion",
  "token",
  "email",
  "phone",
  "payment_card",
  "iban",
];

function assertSurfaceDoesNotContainFixture(
  label: string,
  value: unknown,
  fixture: ReplayCanaryFixture,
): void {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value);
  for (const forbidden of fixture.forbiddenValues) {
    if (serialized.includes(forbidden)) {
      throw new Error(`${label} contains a replay canary value`);
    }
  }
}

function collectRedactions(
  details: WorkflowReplayAttemptDetail[],
): Set<ReplayRedactionClass> {
  const found = new Set<ReplayRedactionClass>();
  for (const detail of details) {
    for (const envelope of [
      detail.input,
      detail.output,
      detail.logs,
      detail.metadata,
    ]) {
      if (!envelope) continue;
      for (const [kind, count] of Object.entries(
        envelope.metadata.redactions,
      )) {
        if ((count ?? 0) > 0) found.add(kind as ReplayRedactionClass);
      }
    }
  }
  return found;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// The canary waits for these surfaces upstream as well, so when one fails here
// the interesting question is what the surface actually held. These render
// shapes only, never values.
function describeApiLogs(details: WorkflowReplayAttemptDetail[]): string {
  if (details.length === 0) return "no attempt details";
  return details
    .map((detail) => `attempt ${detail.id}: logs ${describeType(detail.logs)}`)
    .join("; ");
}

export function assertReplayCanaryEvidence(
  evidence: ReplayCanaryEvidence,
  fixture: ReplayCanaryFixture,
): void {
  if (
    evidence.apiSummary.availability !== "available" ||
    evidence.apiSummary.snapshot === null ||
    evidence.apiSummary.attempts.length === 0
  ) {
    throw new Error("Replay API did not return an available captured trace");
  }
  if (
    evidence.apiDetails.length !== evidence.apiSummary.attempts.length ||
    evidence.apiDetails.some(
      (detail) =>
        !evidence.apiSummary.attempts.some(
          (summary) => summary.id === detail.id,
        ),
    )
  ) {
    throw new Error("Replay API detail coverage does not match its summaries");
  }
  if (!evidence.apiDetails.some((detail) => detail.logs !== null)) {
    throw new Error(
      `Replay canary did not capture a log envelope over the replay API: ${describeApiLogs(evidence.apiDetails)}`,
    );
  }
  if (evidence.runLogs.availability !== "available") {
    throw new Error(
      `Replay run logs did not report an available capture: ${evidence.runLogs.availability}`,
    );
  }
  if (evidence.runLogs.manifest === null || evidence.runLogs.manifestTruncated) {
    throw new Error(
      `Replay run logs did not return the runtime manifest: manifest ${describeType(evidence.runLogs.manifest)}, truncated ${evidence.runLogs.manifestTruncated}`,
    );
  }
  const indexed = evidence.runLogs.attempts.map((attempt) => attempt.id).sort((a, b) => a - b);
  const traced = evidence.apiSummary.attempts.map((attempt) => attempt.id).sort((a, b) => a - b);
  if (
    indexed.length !== traced.length ||
    indexed.some((id, index) => id !== traced[index])
  ) {
    throw new Error(
      `Replay run logs attempt index [${indexed.join(",")}] does not match the trace [${traced.join(",")}]`,
    );
  }

  const redactions = collectRedactions(evidence.apiDetails);
  for (const expected of EXPECTED_REDACTIONS) {
    if (!redactions.has(expected)) {
      throw new Error(
        `Replay canary did not observe expected ${expected} redaction`,
      );
    }
  }

  assertSurfaceDoesNotContainFixture(
    "Replay run logs",
    evidence.runLogs,
    fixture,
  );
  assertSurfaceDoesNotContainFixture(
    "Replay API summary",
    evidence.apiSummary,
    fixture,
  );
  assertSurfaceDoesNotContainFixture(
    "Replay API details",
    evidence.apiDetails,
    fixture,
  );
  assertSurfaceDoesNotContainFixture(
    "Application log export",
    evidence.appendedLogExport,
    fixture,
  );
}
