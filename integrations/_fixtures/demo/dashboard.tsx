/**
 * The dashboard half of the demo integration: the two pages its manifest
 * declares, and the only contributed pages this repository can look at.
 *
 * It is written the way an integration author is asked to write one, so it is
 * also the proof of the two things S7 had to get right. Every block of colour
 * and spacing below comes either from a `@integrations/host-ui` primitive or
 * from an arbitrary Tailwind value on the page's own markup, and the arbitrary
 * ones are deliberately values nothing else in the repository uses: if the
 * dashboard's stylesheet ever stops scanning `integrations/`, the measuring bar
 * on Overview loses its width and its colour and the page says so on sight.
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
  Table,
  defineIntegrationDashboard,
} from "@integrations/host-ui";
import type { manifest } from "./manifest";

function DemoOverview() {
  return (
    <Page
      title="Demo overview"
      description="A page contributed by an integration, rendered by the cockpit."
    >
      <Notice tone="neutral">
        Nothing here reaches the provider. The demo integration exists so the
        contract between an integration and the dashboard can be looked at.
      </Notice>

      <Section
        title="Styling proof"
        description="Written on this page's own markup, with values nothing in the cockpit uses."
      >
        <div className="flex flex-col gap-[7px]">
          <div
            data-demo-measuring-bar=""
            className="h-[9px] w-[137px] rounded-[11px] bg-[#FD6027]"
          />
          <span className="font-mono text-[10.5px] uppercase tracking-[0.11em] text-neutral-500">
            137 px wide, 9 px tall, 11 px radius
          </span>
        </div>
      </Section>

      <Section title="What the host lends a page">
        <div className="grid gap-2 sm:grid-cols-2">
          <Card title="Primitives">
            <KeyValue
              items={[
                { label: "Page", value: "Gutters, heading, rhythm" },
                { label: "Card", value: "This box" },
                { label: "KeyValue", value: "These rows" },
                { label: "Chip", value: <Chip tone="success">Connected</Chip> },
              ]}
            />
          </Card>
          <Card title="Refused on purpose">
            <KeyValue
              items={[
                { label: "Dialog", value: "A page may not take the screen" },
                { label: "Router", value: "A page may not move the person" },
                { label: "Inputs", value: "A page has no write seam yet" },
                { label: "className", value: "A primitive's look is ours" },
              ]}
            />
          </Card>
        </div>
      </Section>

      <Section title="Leaving for the provider">
        <ExternalLink href="https://example.com/demo/docs">Demo provider docs</ExternalLink>
      </Section>
    </Page>
  );
}

function DemoActivity() {
  return (
    <Page
      title="Demo activity"
      description="The second declared page, so a tab strip has something to be."
    >
      <Section title="Recent" description="Fixed rows; the demo provider is deterministic.">
        <Table
          columns={[
            { key: "at", label: "When" },
            { key: "what", label: "What" },
            { key: "count", label: "Messages", align: "end" },
          ]}
          rows={[
            { key: "1", cells: { at: "2026-09-19 09:14", what: "Echoed a message", count: "1" } },
            { key: "2", cells: { at: "2026-09-19 08:02", what: "Looked a query up", count: "12" } },
          ]}
        />
      </Section>

      <Section title="An empty one">
        <EmptyState>
          Nothing has happened on the demo provider today, which is what a
          deterministic provider does.
        </EmptyState>
      </Section>
    </Page>
  );
}

export const dashboard = defineIntegrationDashboard<typeof manifest>({
  pages: {
    overview: DemoOverview,
    activity: DemoActivity,
  },
});
