export type GeneratedFiles = {
  manifests: string;
  runtimes: string;
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
};

/**
 * Set at generation time by the deployments that want the fixture
 * integrations: CI and demo. Production and the Arthur tenant never set it, so
 * the registry they build from holds no import of `integrations/_fixtures`.
 * The committed registry is the one generated without it, which is why
 * `--check` in CI fails on a registry that carries a fixture.
 */
export const FIXTURE_FLAG = "INTEGRATION_FIXTURES";

/** The directory an integration lives in when it is a fixture. */
export const FIXTURES_DIRECTORY = "_fixtures";

/**
 * Directories under `integrations/` that are not integrations. `sdk` is the
 * contract and `registry` is what this generator writes; every other
 * directory without a manifest is a mistake rather than something to skip,
 * which is what keeps a half-written integration from disappearing quietly.
 * A directory whose name starts with `_` is never registered: that is how the
 * template stays out of every build and how the fixtures wait for their flag.
 */
export const NON_INTEGRATION_DIRECTORIES = ["sdk", "registry"] as const;

export const DEFAULT_OUTPUT_PATHS = {
  manifests: "integrations/registry/manifests.generated.ts",
  runtimes: "integrations/registry/runtimes.generated.ts",
} as const;

export const GENERATED_HEADER =
  "// THIS FILE IS GENERATED. DO NOT EDIT.\n// Run pnpm run gen:integrations to update.\n\n";

export const INTEGRATION_ID = /^[a-z][a-z0-9]{2,31}$/u;
