/**
 * The dashboard half: one React component per page the manifest declares.
 *
 * These render inside the cockpit, in its own React tree, and they are built
 * from `@integrations/host-ui`, which is the UI the host lends an integration.
 * The dashboard's own `@/components/ui` is internal to it and the boundaries
 * gate refuses it from here.
 *
 * A page is handed the integration id and nothing else, and it may not import
 * `next/*`, `node:*` or `server-only`, or read `process.env`. Write what your
 * own package knows; anything more is a contract change rather than an import.
 *
 * An integration that declares no pages deletes this file and empties
 * `manifest.pages`. The two have to agree: the generator refuses either half
 * without the other.
 */
import { Card, KeyValue, Page, Section, defineIntegrationDashboard } from "@integrations/host-ui";
import type { manifest } from "./manifest";

function ExampleOverview() {
  return (
    <Page title="Overview" description="What this integration is doing here.">
      <Section title="Account">
        <Card>
          <KeyValue
            items={[
              { label: "Workspace", value: "Replace this with what your provider knows." },
            ]}
          />
        </Card>
      </Section>
    </Page>
  );
}

// The type argument is the manifest's type, imported with `import type` so the
// import erases: a value import would pull the manifest's zod schemas into the
// browser. It is what makes a declared page with no component, and a component
// for a page nobody declared, a compile error rather than an empty tab.
export const dashboard = defineIntegrationDashboard<typeof manifest>({
  pages: { overview: ExampleOverview },
});
