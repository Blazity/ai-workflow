/**
 * The screens this integration adds to the cockpit: one component per page the
 * manifest declares, shown as tabs of its own area next to Connection.
 *
 * A page is a Server Component compiled into the dashboard and run in its
 * process. It is handed `{ integrationId, data }`, where `data` is what this
 * package's own reader (`api.overview` in worker.ts) returned, fetched by the
 * host before the page rendered. It is built from `@integrations/host-ui`. The
 * boundaries gate refuses `@/...`, `next/*`, `node:*` and `server-only` here,
 * and the registry generator refuses a read of the deployment's environment
 * anywhere in this file or a file it imports, comments included: it matches
 * the text, so do not even write the expression down.
 *
 * An integration with no screen of its own deletes this file and empties
 * `manifest.pages`; the generator refuses either half without the other.
 */
import {
  Card,
  EmptyState,
  KeyValue,
  Notice,
  Page,
  Section,
  defineIntegrationDashboard,
  type IntegrationPageProps,
} from "@integrations/host-ui";
import type { manifest } from "./manifest";

const DESCRIPTION = "The account this deployment acts as.";

interface Account {
  readonly name: string;
  readonly plan: string;
}

/**
 * Read back what the reader returned, defensively: the dashboard and the
 * worker can be one deploy apart, and a page that throws on a field it did not
 * get takes its tab down with it.
 */
function readAccount(value: unknown): Account | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.plan !== "string") return null;
  return { name: record.name, plan: record.plan };
}

function OverviewPage({ data }: IntegrationPageProps) {
  if (data.status === "unavailable") {
    return (
      <Page title="Overview" description={DESCRIPTION}>
        <Notice tone={data.cause === "worker" ? "neutral" : "warning"}>{data.reason}</Notice>
      </Page>
    );
  }
  if (data.status === "none") {
    return (
      <Page title="Overview" description={DESCRIPTION}>
        <EmptyState>This page has nothing to read yet.</EmptyState>
      </Page>
    );
  }
  const account = readAccount(data.value);
  if (!account) {
    return (
      <Page title="Overview" description={DESCRIPTION}>
        <Notice tone="warning">Example answered in a shape this page does not read.</Notice>
      </Page>
    );
  }
  return (
    <Page title="Overview" description={DESCRIPTION}>
      <Section title="Account">
        <Card>
          <KeyValue
            items={[
              { label: "Name", value: account.name },
              { label: "Plan", value: account.plan },
            ]}
          />
        </Card>
      </Section>
    </Page>
  );
}

// The manifest's type, imported with `import type`, so the import erases and
// the manifest's zod schemas never reach the browser. It is what makes a page
// declared without a component, and a component for a page nobody declared, a
// compile error.
export const dashboard = defineIntegrationDashboard<typeof manifest>({
  pages: { overview: OverviewPage },
});
