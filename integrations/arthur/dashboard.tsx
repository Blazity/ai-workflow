/**
 * Evals: how the engine graded the last day of agent work.
 *
 * Everything it shows comes from `data`, which the cockpit resolved through
 * this package's own reader before the page rendered. The answers stay apart
 * on the screen, because a person acts differently on each: our worker did not
 * answer, the engine could not be read, the engine graded nothing, or here are
 * the numbers, with failures among them or not.
 */
import {
  Card,
  Chip,
  EmptyState,
  ExternalLink,
  KeyValue,
  Notice,
  Page,
  Section,
  defineIntegrationDashboard,
  type IntegrationPageProps,
} from "@integrations/host-ui";
import type { manifest } from "./manifest";

interface EvalSummary {
  windowHours: number;
  spansGraded: number;
  /** Absent from a worker one deploy behind this page. */
  spansFailed: number | null;
  traceCount: number;
  score: number;
  tasksRead: number | null;
  truncated: boolean;
}

/**
 * Read back what this package's own reader returned. Defensive on purpose: a
 * dashboard and a worker can be one deploy apart, and a page that throws on a
 * field it did not get takes its tab down with it.
 */
function readSummary(value: unknown): EvalSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const numbers = ["windowHours", "spansGraded", "traceCount", "score"] as const;
  if (!numbers.every((key) => typeof record[key] === "number")) return null;
  const optionalNumber = (key: string): number | null =>
    typeof record[key] === "number" ? (record[key] as number) : null;
  return {
    windowHours: record.windowHours as number,
    spansGraded: record.spansGraded as number,
    spansFailed: optionalNumber("spansFailed"),
    traceCount: record.traceCount as number,
    score: record.score as number,
    tasksRead: optionalNumber("tasksRead"),
    truncated: record.truncated === true,
  };
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

const DESCRIPTION = "Continuous evaluation of what the agents did.";

function TruncatedNotice({ summary }: { summary: EvalSummary }) {
  if (!summary.truncated) return null;
  return (
    <Notice tone="warning">
      The engine holds more tasks than it returns in one read
      {summary.tasksRead === null ? "" : ` (${count(summary.tasksRead)} were read)`}, so these
      figures leave some tasks out. They are a lower bound, not the whole of the last{" "}
      {summary.windowHours} hours.
    </Notice>
  );
}

function ArthurEvals({ data }: IntegrationPageProps) {
  if (data.status === "unavailable") {
    if (data.cause === "worker") {
      return (
        <Page title="Evals" description={DESCRIPTION}>
          <Notice tone="warning">
            Our worker could not answer, so the Arthur Engine was not asked anything. Nothing is known
            about the engine from this: reload in a minute, and if it persists, System health says
            whether the worker is up.
          </Notice>
        </Page>
      );
    }
    if (data.cause === "not_connected") {
      return (
        <Page title="Evals" description={DESCRIPTION}>
          <EmptyState>{data.reason} The Connection tab says what it needs.</EmptyState>
        </Page>
      );
    }
    return (
      <Page title="Evals" description={DESCRIPTION}>
        <Notice tone="warning">
          The Arthur Engine was asked and could not be read, so there is nothing to show rather than
          nothing to grade: {data.reason}
        </Notice>
        <Section title="What to check">
          <KeyValue
            items={[
              { label: "Connection", value: "The Connection tab says whether the key still works." },
              { label: "Endpoint", value: "The trace endpoint must end in /api/v1/traces." },
            ]}
          />
        </Section>
      </Page>
    );
  }

  const summary = data.status === "ok" ? readSummary(data.value) : null;
  if (!summary) {
    return (
      <Page title="Evals" description={DESCRIPTION}>
        <EmptyState>
          This build could not read the engine&apos;s answer. The dashboard and the worker are
          probably on different versions; a redeploy of both is what fixes it.
        </EmptyState>
      </Page>
    );
  }

  if (summary.spansGraded === 0) {
    return (
      <Page title="Evals" description={DESCRIPTION}>
        <TruncatedNotice summary={summary} />
        <EmptyState>
          {`Nothing was graded in the last ${summary.windowHours} hours. The engine received ${count(
            summary.traceCount,
          )} ${summary.traceCount === 1 ? "trace; grading it" : "traces; grading them"} is configured on the engine, not here.`}
        </EmptyState>
        <Section title="Where grading is set up">
          <ExternalLink href="https://docs.arthur.ai/">Arthur Engine documentation</ExternalLink>
        </Section>
      </Page>
    );
  }

  return (
    <Page
      title="Evals"
      description={`Continuous evaluation over the last ${summary.windowHours} hours.`}
    >
      <TruncatedNotice summary={summary} />
      <Section title="Quality">
        <Card title="Pass rate">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {summary.score.toFixed(1)}%
            </span>
            <Chip tone={summary.score >= 90 ? "success" : summary.score >= 75 ? "warning" : "failed"}>
              {count(summary.spansGraded)} graded
            </Chip>
            {summary.spansFailed !== null && summary.spansFailed > 0 && (
              <Chip tone="failed">{count(summary.spansFailed)} failed</Chip>
            )}
          </div>
        </Card>
      </Section>

      <Section title="The window" description="What the engine saw, and how much of it was graded.">
        <KeyValue
          items={[
            { label: "Spans graded", value: count(summary.spansGraded) },
            ...(summary.spansFailed === null
              ? []
              : [{ label: "Spans failed", value: count(summary.spansFailed) }]),
            { label: "Traces received", value: count(summary.traceCount) },
            { label: "Window", value: `${summary.windowHours} hours` },
          ]}
        />
      </Section>
    </Page>
  );
}

export const dashboard = defineIntegrationDashboard<typeof manifest>({
  pages: { evals: ArthurEvals },
});
