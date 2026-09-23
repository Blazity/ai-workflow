// What `defineIntegrationDashboard` promises at compile time: a dashboard
// names exactly the pages its manifest declares. The promise is a type, so it
// is proved by compiling probes against it, each mistake marked with
// `@ts-expect-error`: a probe that stops being an error turns its directive
// into one, and the compile below fails.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const here = import.meta.dirname;

const PROBE = `
import type { IntegrationManifest } from "@integrations/sdk";
import { defineIntegrationDashboard, type IntegrationPageComponent } from "../../contract";

type WithPages<P extends IntegrationManifest["pages"]> = Omit<IntegrationManifest, "pages"> & {
  readonly pages: P;
};
type NoPages = WithPages<readonly []>;
type Overview = WithPages<readonly [{ readonly id: "overview"; readonly label: "Overview" }]>;
declare const Page: IntegrationPageComponent;

defineIntegrationDashboard<Overview>({ pages: { overview: Page } });
defineIntegrationDashboard<NoPages>({ pages: {} });

// @ts-expect-error a declared page without its component
defineIntegrationDashboard<Overview>({ pages: {} });
// @ts-expect-error a component nobody declared, beside the one that is
defineIntegrationDashboard<Overview>({ pages: { overview: Page, extra: Page } });
// @ts-expect-error a component when the manifest declares no page at all
defineIntegrationDashboard<NoPages>({ pages: { overview: Page } });
`;

test("a dashboard names exactly the pages its manifest declares, none included", async (t) => {
  // Under the package's own node_modules, which git ignores and where
  // @integrations/sdk already resolves.
  const directory = await mkdtemp(join(here, "node_modules/.contract-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = join(directory, "probe.ts");
  await writeFile(probe, PROBE);

  const program = ts.createProgram([probe], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const problems = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

  assert.deepEqual(problems, []);
});
