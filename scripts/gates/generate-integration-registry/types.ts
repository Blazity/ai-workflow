export type GeneratedFiles = {
  manifests: string;
  runtimes: string;
  dashboards: string;
};

export type GeneratorOptions = {
  root: string;
  /** Defaults to `<root>/integrations`. */
  integrationsRoot?: string;
  /** Forwarded to the block catalog reader, which owns the core block types. */
  blocksRoot?: string;
  /**
   * Fixtures are compiled into the build only where a deployment asks for
   * them. See `FIXTURE_FLAG`.
   */
  includeFixtures?: boolean;
  outputPaths?: Partial<Record<keyof GeneratedFiles, string>>;
};

export type IntegrationRecord = {
  /** Repository-relative, for example `integrations/jira`. */
  directory: string;
  id: string;
  packageName: string;
  blockTypes: string[];
  /** Fixtures reach the registries only behind `FIXTURE_FLAG`. */
  fixture: boolean;
  manifestPath: string;
  workerPath: string;
  /** The page ids the manifest declares, in declaration order. */
  pageIds: string[];
  /** `dashboard.tsx`, present exactly when the manifest declares a page. */
  dashboardPath: string | null;
};

/**
 * Set at generation time by a developer who wants the fixture integrations in
 * a local registry. No deployment and no CI job sets it: the committed
 * registry is the one generated without it, which is why `--check` (run by CI
 * and by the worker build) fails on a registry that carries a fixture. Tests
 * reach the fixtures by passing `includeFixtures` to the generator directly.
 */
export const FIXTURE_FLAG = "INTEGRATION_FIXTURES";

/** The directory an integration lives in when it is a fixture. */
export const FIXTURES_DIRECTORY = "_fixtures";

/**
 * Directories under `integrations/` that are not integrations. `sdk` is the
 * contract an integration's worker half is written against, `host-ui` the one
 * its dashboard half is written against, and `registry` is what this generator
 * writes; every other directory without a manifest is a mistake rather than
 * something to skip, which is what keeps a half-written integration from
 * disappearing quietly. A directory whose name starts with `_` is never
 * registered: that is how the template stays out of every build and how the
 * fixtures wait for their flag.
 */
export const NON_INTEGRATION_DIRECTORIES = ["sdk", "host-ui", "registry"] as const;

export const DEFAULT_OUTPUT_PATHS = {
  manifests: "integrations/registry/manifests.generated.ts",
  runtimes: "integrations/registry/runtimes.generated.ts",
  dashboards: "integrations/registry/dashboard.generated.ts",
} as const;

export const GENERATED_HEADER =
  "// THIS FILE IS GENERATED. DO NOT EDIT.\n// Run pnpm run gen:integrations to update.\n\n";
