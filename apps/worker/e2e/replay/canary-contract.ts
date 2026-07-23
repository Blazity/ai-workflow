import { isAbsolute } from "node:path";
import type {
  ReplayRedactionClass,
  WorkflowReplayAttemptDetail,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import { z } from "zod";

const schema = z
  .object({
    REPLAY_CANARY_DASHBOARD_BASE_URL: z.string().url(),
    REPLAY_CANARY_DASHBOARD_EXPECTED_HOST: z.string().trim().min(1),
    REPLAY_CANARY_DASHBOARD_AUTOMATION_BYPASS_SECRET: z.string().min(1),
    REPLAY_CANARY_LOG_EXPORT_PATH: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, "The log export path must be absolute"),
    REPLAY_CANARY_LOG_WAIT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(120_000),
    REPLAY_CANARY_LOG_SETTLE_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60_000)
      .default(15_000),
    REPLAY_CANARY_LOG_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(134_217_728)
      .default(33_554_432),
  })
  .superRefine((value, context) => {
    const base = new URL(value.REPLAY_CANARY_DASHBOARD_BASE_URL);
    if (base.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["REPLAY_CANARY_DASHBOARD_BASE_URL"],
        message: "The replay canary must target an HTTPS dashboard preview",
      });
    }
    if (base.host !== value.REPLAY_CANARY_DASHBOARD_EXPECTED_HOST) {
      context.addIssue({
        code: "custom",
        path: ["REPLAY_CANARY_DASHBOARD_EXPECTED_HOST"],
        message: "The dashboard preview host does not match the expected host",
      });
    }
  });

export type ReplayCanaryEnv = z.infer<typeof schema>;

export function parseReplayCanaryEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ReplayCanaryEnv {
  return schema.parse(source);
}

export interface ReplayCanaryFixture {
  ticketDescription: string;
  forbiddenValues: string[];
}

const NONCE_PATTERN = /^[a-f0-9]{24}$/;

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

export interface ReplayCanaryDatabaseRows {
  observation: unknown;
  attempts: unknown[];
}

export interface ReplayCanaryEvidence {
  runId: string;
  databaseRows: ReplayCanaryDatabaseRows;
  apiSummary: WorkflowRunReplayResponse;
  apiDetails: WorkflowReplayAttemptDetail[];
  dashboardHtml: string;
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

function hasDatabaseLogEnvelope(rows: ReplayCanaryDatabaseRows): boolean {
  return rows.attempts.some((attempt) => {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) {
      return false;
    }
    return (attempt as Record<string, unknown>).log_envelope != null;
  });
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
  if (
    !evidence.apiDetails.some((detail) => detail.logs !== null) ||
    !hasDatabaseLogEnvelope(evidence.databaseRows)
  ) {
    throw new Error("Replay canary did not capture a log envelope");
  }

  const redactions = collectRedactions(evidence.apiDetails);
  for (const expected of EXPECTED_REDACTIONS) {
    if (!redactions.has(expected)) {
      throw new Error(
        `Replay canary did not observe expected ${expected} redaction`,
      );
    }
  }

  if (
    !evidence.dashboardHtml.includes('data-replay-canvas="true"') ||
    !evidence.dashboardHtml.includes("Visual replay")
  ) {
    throw new Error("Dashboard did not server-render the visual replay trace");
  }
  if (!evidence.appendedLogExport.includes(evidence.runId)) {
    throw new Error("Log export does not prove coverage of the canary run");
  }

  assertSurfaceDoesNotContainFixture(
    "Replay database rows",
    evidence.databaseRows,
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
    "Server-rendered dashboard trace",
    evidence.dashboardHtml,
    fixture,
  );
  assertSurfaceDoesNotContainFixture(
    "Application log export",
    evidence.appendedLogExport,
    fixture,
  );
}
