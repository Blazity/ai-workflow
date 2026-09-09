# Package contracts and import-boundary enforcement in a pnpm/TypeScript/Nitro/Workflow monorepo

Primary-source research, 2026-09-09. Question: for a pnpm workspace monorepo (Node 22+, ESM, a
Nitro 2 server hosting Vercel Workflow, a Next.js 15 App Router app), what mechanisms exist to
define package contracts, enforce import boundaries, respect Vercel Workflow/Nitro's placement
constraints, and use pnpm catalogs plus TS project references.

## 1. Scope and method

Primary sources only: `nodejs.org/api`, `pnpm.io`, `typescriptlang.org`, the `sverweij/dependency-cruiser`
and `javierbrea/eslint-plugin-boundaries` GitHub repos (READMEs, doc files, and the published npm
package contents), `typescript-eslint.io`, `oxc.rs`, `knip.dev`, `vercel.com/docs/workflows` and
`workflow-sdk.dev`, the `vercel/workflow` GitHub repo (including npm package internals, since
`packages/nitro/README.md` on `main` is a single line and the fuller answer lives in the published
docs site and the `nitropack`/`nitro` npm packages themselves), `nitro.build`, and the shipped
`nitropack@2.13.4` npm package (this repo's pinned dependency). No Medium, dev.to, or Reddit
content is cited.

Per task scope, the only repo files read were `apps/worker/nitro.config.ts`, `apps/worker/package.json`,
`apps/shared/contracts/package.json`, and `apps/worker/tsconfig.json`. That confirmed: Nitro preset
`vercel`, `srcDir: "src"`, `nitropack@2.13.4`, `workflow@4.8.0`; `@shared/contracts` ships `"main": "./dist/index.js"`
plus an `exports["."]` map to `dist/index.d.ts`/`dist/index.js` and a `build` script (`tsc -p tsconfig.build.json`);
and `apps/worker/tsconfig.json` `include`s `../shared/contracts/**/*.ts` directly alongside `moduleResolution: "Bundler"`.

**Version note, checked directly against the pinned dependency.** `nitro.build`'s current docs and
the `nitro` GitHub repo's `main` branch describe Nitro 3 (`nitro@3.0.260903-beta` as of this
writing), where the config field is `serverDir` and `srcDir` carries `/** @deprecated Migrate to
`serverDir`. */`. This repo depends on `nitropack@2.13.4`. Its published type declarations
(`dist/shared/nitro.D682J6aL.d.mts` inside the npm tarball) list `srcDir: string;` as a plain,
non-deprecated field alongside `workspaceDir`, `rootDir`, `scanDirs`, `apiDir`, `routesDir`; there
is no top-level `serverDir: string | false` scan-root field in 2.13.4. Any Hard Rule below sourced
from `nitro.build` therefore documents Nitro 3 behavior; where it differs from the pinned 2.13.4,
that is called out explicitly rather than silently applied to this repo.

---

## 2. Hard rules

| # | Mechanism | Exact quote | Source |
|---|-----------|-------------|--------|
| H1 | `exports` replaces `main` and blocks unlisted subpaths | "The `\"exports\"` provides a modern alternative to `\"main\"` allowing multiple entry points to be defined, conditional entry resolution support between environments, and **preventing any other entry points besides those defined in `\"exports\"`**." | https://nodejs.org/api/packages.html |
| H2 | Deep imports outside `exports` throw | "When the `\"exports\"` field is defined, all subpaths of the package are encapsulated and no longer available to importers... `require('pkg/subpath.js')` throws an `ERR_PACKAGE_PATH_NOT_EXPORTED` error." | https://nodejs.org/api/packages.html |
| H3 | `exports` wins over `main` | "If both `\"exports\"` and `\"main\"` are defined, the `\"exports\"` field takes precedence over `\"main\"`." | https://nodejs.org/api/packages.html |
| H4 | Encapsulation is not absolute | "It is not a strong encapsulation since a direct require of any absolute subpath of the package such as `require('/path/to/node_modules/pkg/subpath.js')` will still load `subpath.js`." | https://nodejs.org/api/packages.html |
| H5 | Conditions ordered most-to-least specific | "The general rule is that conditions should be from most specific to least specific in object order." | https://nodejs.org/api/packages.html |
| H6 | `imports` is private and `#`-prefixed | "There is a package `\"imports\"` field to create private mappings that only apply to import specifiers from within the package itself... Entries in the `\"imports\"` field must always start with `#`." | https://nodejs.org/api/packages.html |
| H7 | `null` targets exclude subpaths | "To exclude private subfolders from patterns, `null` targets can be used" (example: `"./features/private-internal/*": null`). | https://nodejs.org/api/packages.html |
| H8 | TypeScript always tries `types`/`default` conditions | "When using conditional `\"exports\"`, TypeScript always matches the `\"types\"` and `\"default\"` conditions if present." | https://www.typescriptlang.org/docs/handbook/modules/reference.html |
| H9 | A workspace needs `pnpm-workspace.yaml` | "A workspace must have a `pnpm-workspace.yaml` file in its root." | https://pnpm.io/workspaces |
| H10 | `workspace:` protocol refuses non-local resolution | "When this protocol is used, pnpm will refuse to resolve to anything other than a local workspace package." | https://pnpm.io/workspaces |
| H11 | pnpm blocks phantom dependencies by default | "Even though all the dependencies will be hard linked into the root `node_modules`, packages will have access only to those dependencies that are declared in their `package.json`, so pnpm's strictness is preserved." | https://pnpm.io/workspaces |
| H12 | Semistrict default, `shamefully-hoist` opts out | "By default, pnpm creates a semistrict `node_modules`, meaning dependencies have access to undeclared dependencies but modules outside of `node_modules` do not." (`shamefullyHoist` default `false`.) | https://pnpm.io/settings/node-modules |
| H13 | `hoistPattern`/`publicHoistPattern` control what leaks | `publicHoistPattern` "hoists dependencies matching the pattern to the root modules directory," enabling application code to reach otherwise-undeclared (phantom) dependencies; `hoistPattern` defaults to `['*']` and hoists only into the hidden virtual-store `node_modules`. | https://pnpm.io/settings/node-modules |
| H14 | `strictPeerDependencies` default is off | "If this is enabled, commands will fail if there is a missing or invalid peer dependency in the tree." Default: `false`. | https://pnpm.io/settings/peer-dependencies |
| H15 | Catalogs are reusable version constants | "*Catalogs* are a workspace feature for defining dependency version ranges as reusable constants." Declared via the `catalog:` protocol plus a `catalog` or `catalogs` key in `pnpm-workspace.yaml`. | https://pnpm.io/catalogs |
| H16 | Catalog protocol is stripped on publish | "The `catalog:` protocol is removed when running `pnpm publish` or `pnpm pack`." | https://pnpm.io/catalogs |
| H17 | `pnpm deploy` needs injected workspace packages | "By default, the deploy command only works with workspaces that have the `inject-workspace-packages` setting set to `true`." | https://pnpm.io/cli/deploy |
| H18 | `pnpm deploy` produces an isolated, portable tree | "During deployment, the files of the deployed package are copied to the target directory. All dependencies of the deployed package, including dependencies from the workspace, are installed inside an isolated `node_modules` directory at the target directory." | https://pnpm.io/cli/deploy |
| H19 | `composite` is required for project references | "Referenced projects must have the new `composite` setting enabled... The `rootDir` setting, if not explicitly set, defaults to the directory containing the `tsconfig` file; all implementation files must be matched by an `include` pattern or listed in `files`; `declaration` must be turned on." | https://www.typescriptlang.org/docs/handbook/project-references.html |
| H20 | Cross-project imports load `.d.ts`, not source | "Importing modules from a referenced project will instead load its _output_ declaration file (`.d.ts`)." | https://www.typescriptlang.org/docs/handbook/project-references.html |
| H21 | `tsc -b` builds referenced projects in order | "Running `tsc --build` (`tsc -b`)... Find all referenced projects, Detect if they are up-to-date, Build out-of-date projects in the correct order." | https://www.typescriptlang.org/docs/handbook/project-references.html |
| H22 | `isolatedDeclarations`, one line | "Require sufficient annotation on exports so other tools can trivially generate declaration files." | https://www.typescriptlang.org/tsconfig/#isolatedDeclarations |
| H23 | `verbatimModuleSyntax`, one line | "Do not transform or elide any imports or exports not marked as type-only, ensuring they are written in the output file's format based on the 'module' setting." | https://www.typescriptlang.org/tsconfig/#verbatimModuleSyntax |
| H24 | `customConditions` feeds `exports`/`imports` resolution | "`--customConditions` takes a list of additional conditions that should succeed when TypeScript resolves from an `exports` or `imports` field of a `package.json`." | https://www.typescriptlang.org/tsconfig/#customConditions |
| H25 | dependency-cruiser validates a dependency graph against rules | "Validate and visualise dependencies. With your rules." It "validates them against (your own) rules [and] reports violated rules." | https://github.com/sverweij/dependency-cruiser (README) |
| H26 | `circular` rule matches cycles | "A Boolean indicating whether or not to match module dependencies that end up where you started (a.k.a. circular dependencies)." | https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md |
| H27 | `from`/`to` define a forbidden-path rule | "Conditions an end of a dependency should match to be caught by this rule. Leave it empty if you want any module to be matched." `from` is "the path from the current working directory... to the file containing a dependency"; `to` is the same for "the file the dependency resolves to." | https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md |
| H28 | `reachable` targets transitive dead wood | "`reachable` is a Boolean indicating whether or not modules matching the `to` part of the rule are _reachable_ (either directly or via other modules) from modules matching the `from` part." | https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md |
| H29 | `required` rules describe mandatory dependencies | "A list of rules that describe what dependencies modules _must_ have, like 'every controller _must depend on_ the base controller'." Has "a mandatory `module` attribute" plus a `to`. | https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md |
| H30 | `--ignore-known` is the baseline mechanism | "With this option engaged dependency-cruiser will ignore known violations as saved in the file you pass it as a parameter" (default `.dependency-cruiser-known-violations.json`). | https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md |
| H31 | `--baseline` writes/updates that file | "This option creates or updates the known violations... This option implies `--no-ignore-known` and `--no-cache`." | https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md |
| H32 | eslint-plugin-boundaries classifies files by pattern | Settings define element types via folder patterns, e.g. `type: "controller", pattern: "controllers/*"`, under `settings["boundaries/elements"]`. | https://github.com/javierbrea/eslint-plugin-boundaries (README) |
| H33 | `boundaries/dependencies` is the core rule (7.x) | The published package (`eslint-plugin-boundaries@7.2.0`) ships rule modules `Dependencies`, `EntryPoint`, `External`, `NoIgnored`, `NoPrivate`, `NoUnknown`, `NoUnknownFiles`, confirmed against the package's own `dist/Rules/*` file listing. `entry-point` "ensures that elements cannot import files from another element except through the defined entry point"; `no-private` "ensures that elements cannot import the children of another element"; `external` "checks which external dependencies can be used by each element." | https://www.jsboundaries.dev/docs/rules/ and jsdelivr package metadata for `eslint-plugin-boundaries@7.2.0` |
| H34 | `@typescript-eslint/no-restricted-imports` adds type-aware paths | "Disallow specified modules when loaded by `import`," extended with an `allowTypeImports` option, default `false`, and support for `import type`/`export type` syntax. | https://typescript-eslint.io/rules/no-restricted-imports/ |
| H35 | oxlint implements `no-cycle` and `no-restricted-imports`, not a boundaries rule | oxlint's rule list carries `import/no-cycle` (restriction category) and `eslint/no-restricted-imports` (restriction category). No rule named `boundaries` or equivalent appears in the reference. | https://oxc.rs/docs/guide/usage/linter/rules.html |
| H36 | knip finds unused files, exports, and dependencies | "Knip finds unused dependencies, exports and files in your JavaScript and TypeScript projects," via "advanced analysis starting from fine-grained entry points based on the actual frameworks and tooling in (mono)repos." | https://knip.dev/ |
| H37 | knip ships 150+ framework plugins including Next.js and Vitest | "Knip comes with 150+ plugins for tools and frameworks like Astro, Cypress, ESLint, Jest, GitHub Actions, Next.js, Nx, Remix, Storybook, Svelte, Vite, Vitest, Webpack and many, many more." | https://knip.dev/ |
| H38 | `'use workflow'` marks a durable, replayed function | "The `'use workflow'` directive marks a function as durable, which means it remembers its progress and can resume exactly where it left off... If a deploy or crash happens, the system replays execution deterministically from where it stopped." | https://vercel.com/docs/workflows/concepts |
| H39 | `'use step'` marks retried, isolated work | "A step is a stateless function that runs a unit of durable work inside a workflow. The `'use step'` directive marks a function as a step, which gives it built-in retries... Each step compiles into an isolated API route." | https://vercel.com/docs/workflows/concepts |
| H40 | Workflows run sandboxed and must be deterministic; steps get full Node | Workflow functions run "in a sandboxed environment without full Node.js access" and "must be deterministic," with `Math.random` and `Date` fixed during replay; steps have "full Node.js runtime and npm package access." | https://workflow-sdk.dev/docs/foundations/workflows-and-steps (Context7 `/vercel/workflow`, and confirmed independently by the `@workflow/nest` example: "Steps have full Node.js and npm access") |
| H41 | Cross-boundary values must be serializable, passed by value | "All function arguments and return values passed between workflow and step functions must be serializable... Parameters are passed by value, not by reference. Steps receive deserialized copies of data." | https://workflow-sdk.dev/docs/foundations/serialization |
| H42 | Directives are AST-recognized per file, not string-matched | "The plugin eliminates false positives (for example, directive-like strings inside template literals) because it recognizes only genuine directive expression statements." Directives must be "at the beginning (above any other code, including imports for module-level)" and use straight quotes. | https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md |
| H43 | `detect` mode is the build-discovery walk | "Detect mode is a lightweight, non-transforming mode used during the build discovery phase. It walks the AST to find `\"use workflow\"` and `\"use step\"` directives." | https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md |
| H44 | `@workflow/builders` is the shared bundler substrate | "This package contains the core build logic for transforming workflow source files into deployable bundles. It is used by: `@workflow/cli`... `@workflow/next`... `@workflow/nitro`." Architecture: "esbuild for bundling and tree-shaking," "SWC for transforming workflow directives," "Enhanced resolve for TypeScript path mapping." | https://github.com/vercel/workflow/blob/main/packages/builders/README.md |
| H45 | `workflow/nitro`'s `dirs` option and its default | Module options read from the Nitro config's `workflow` key. `dirs: string[]`: "Directories to scan for workflows and steps. By default, the `workflows/` directory is scanned from the project root and all layer source directories." | https://workflow-sdk.dev/docs/api-reference/workflow-nitro |
| H46 | `workflow/nitro` roots discovery at `workspaceDir`, not `srcDir` | "Uses Nitro's `workspaceDir` as the workflow project root so monorepo apps can import sibling workspace packages without extra workflow config." (Identical sentence also stands alone as the entire `packages/nitro/README.md` on `vercel/workflow` `main`.) | https://workflow-sdk.dev/docs/api-reference/workflow-nitro and https://github.com/vercel/workflow/blob/main/packages/nitro/README.md |
| H47 | Nitro's `workspaceDir` auto-detects the pnpm workspace | "Project workspace root directory. Auto-detected from the workspace (e.g. pnpm workspace) when not set." | https://nitro.build/config#workspacedir (Nitro 3; see version note above) |
| H48 | Nitro 3 deprecates `srcDir` in favor of `serverDir` | Nitro 3's `NitroConfig.srcDir` carries `/** @deprecated Migrate to \`serverDir\`. */`; `serverDir` is "Server directory for scanning `api/`, `routes/`, `plugins/`, `utils/`, `middleware/`, `modules/`, and `tasks/` folders." Default `false`. | https://raw.githubusercontent.com/nitrojs/nitro/main/src/types/config.ts (Nitro 3 source; not the version this repo pins) |
| H49 | Nitro 2 (`nitropack@2.13.4`, this repo's pin) keeps `srcDir` live | The shipped `nitropack@2.13.4` type declarations list `workspaceDir`, `rootDir`, `srcDir`, `scanDirs`, `apiDir`, `routesDir` as sibling `NitroConfig` fields, with no `@deprecated` marker on `srcDir` and no top-level `serverDir` scan-root field. | npm package `nitropack@2.13.4`, file `dist/shared/nitro.D682J6aL.d.mts` |
| H50 | `scanDirs` auto-registers extra route directories | "Additional directories to scan and auto-register files such as API route handlers." | https://nitro.build/config#scandirs |
| H51 | Externalized packages skip Nitro's `alias` | "Externalized packages are imported at runtime instead of being bundled, so they do not see your `alias` configuration." | https://nitro.build/guide (config section) |
| H52 | `transpilePackages` compiles monorepo/`node_modules` source | "Use `transpilePackages` to compile and bundle a dependency instead of treating it as untouched runtime code... Next.js does not compile code inside `node_modules` by default." | https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages |
| H53 | Turbopack auto-transpiles workspace packages; webpack needs the list for Pages Router cross-app source | "Turbopack transpiles workspace packages (npm, pnpm, or Yarn workspaces) in your monorepo automatically under both routers... Add a package to `transpilePackages` when... the dependency's source lives outside the next app's directory. For example, an `apps/web` app importing `packages/ui` in the same monorepo." | https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages |
| H54 | A package cannot be both transpiled and external | "A package cannot appear in both `transpilePackages` and `serverExternalPackages`; Next.js throws at build start if it does." | https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages |
| H55 | `typescript.tsconfigPath` can swap the build's tsconfig | "In some cases, you might want to use a different TypeScript configuration for builds or tooling... You might need to relax checks in scenarios like monorepos, where the build also validates shared dependencies that don't match your project's standards." | https://nextjs.org/docs/app/api-reference/config/typescript |

---

## 3. What this means for a 2-app pnpm monorepo

### (a) Package contracts

`exports` (H1-H4) is the actual contract surface: whatever is not listed is unreachable from
outside the package, and Node enforces this at resolution time, not just by convention. A
type-only package (one that ships only a `.d.ts` and no runtime file) is not a distinct mechanism
in the Node spec: it is just a package whose `exports["."].default` happens to point at a stub or
whose only meaningful condition is `types`; TypeScript's own rule (H8) that it always tries `types`
first is what makes that work reliably under `moduleResolution: "bundler"`. `@shared/contracts` in
this repo is the concrete pattern: `package.json` declares `exports["."] = { types: "./dist/index.d.ts",
default: "./dist/index.js" }`, so any consumer resolves through the built `dist/`, never the
package's `src/`. But `apps/worker/tsconfig.json` also lists `../shared/contracts/**/*.ts` in
`include`, meaning the *editor/typecheck* experience reads shared source directly for fast
feedback, while the *runtime and build* resolve through the compiled `dist/` via the workspace
symlink. That combination (source for typechecking, dist for `exports`) is exactly why
`build:shared` has to run before `nitro build`/`nitro dev` in `apps/worker/package.json`: if `dist/`
is stale or missing, `exports` still points at it and Node/Nitro will bundle whatever is there,
independent of what `tsc` just saw.

### (b) Import-boundary and cycle rules

Nothing in Node, pnpm, or plain TypeScript enforces "directory X may not import directory Y"
inside one package. pnpm's strictness (H9-H14) only guards the *dependency-declaration* boundary:
a package can't reach a peer's transitive dependency it never declared. It says nothing about
`apps/worker/src/foo.ts` importing `apps/dashboard/src/bar.ts` by relative path, or about
`workflow-definition/` importing `sandbox/` when the intent is a one-way layering. That gap is
exactly what dependency-cruiser, eslint-plugin-boundaries, and (partially) oxlint fill (H25-H35,
compared in §4). TS project references (H19-H21) enforce a *different*, coarser boundary: only
between declared `composite` projects, and only by making the compiler physically unable to see a
non-referenced project's private types, useful between `apps/worker` and `apps/shared/*`, useless
for rules inside `apps/worker/src`.

### (c) Vercel Workflow / Nitro placement constraints

Two mechanisms compose here, and they answer the deliverable question directly (spelled out in
§5): `workflow/nitro` roots step/workflow discovery at Nitro's `workspaceDir`, i.e. the pnpm
workspace root, not at `srcDir`/`apps/worker/src` (H46-H47); and discovery itself is directory-list
based, not "anything reachable": the `dirs` option defaults to "`workflows/` ... from the project
root and all layer source directories" (H45). Discovery is driven by an SWC AST walk over files
inside those directories (H42-H43), not by directory naming inside `apps/worker` specifically. What
goes in a `"use workflow"` body is constrained to deterministic, sandboxed code (H40); what goes in
a `"use step"` body gets full Node/npm access, so that is where a database client, an SDK call, or
any side-effecting workspace-package import belongs. Values crossing the boundary must serialize
(H41), which constrains what kind of object a shared `@shared/contracts` type can carry across it
(plain data, not class instances, unless the class implements the SDK's serialize/deserialize
hooks).

### (d) pnpm catalogs and TS project references

Catalogs (H15-H16) solve version drift, not import boundaries: a `catalog:` entry in one
`package.json` still resolves to a real semver range pinned once in `pnpm-workspace.yaml`, so
`apps/worker` and `apps/dashboard` can share a `zod` or `typescript` version without every
`package.json` repeating it, and `pnpm publish` strips the protocol back to a concrete range so a
published package never leaks an unresolvable specifier. Project references (H19-H21) give a
monorepo incremental, dependency-ordered builds and a hard type wall between `composite` projects
(consumers only ever see `.d.ts`, H20), but only where `references` arrays are actually declared
and `tsc -b` is actually the thing being run; a plain `tsc --noEmit` invocated per-package (as
`apps/worker/package.json`'s `typecheck` script does, per the file read for this task) does not
require or benefit from `composite`/`references` at all.

---

## 4. Comparison of import-boundary enforcement options

| Option | What it enforces | Where it runs | Cost to adopt | Baseline/ratchet support | Citation |
|---|---|---|---|---|---|
| dependency-cruiser | Arbitrary `from`/`to` path-pattern rules, `no-circular`, `reachable` (dead/transitive code), `required` (mandatory deps), on the actual resolved module graph | Standalone CLI; drop into a pre-commit hook, `pnpm` script, or CI step; also produces graphs (dot/mermaid) | Medium: `--init` scaffolds a config with sane defaults (circular detection out of the box); custom `from`/`to` rules for app-vs-app boundaries need to be hand-written | Yes, native: `--baseline` writes a known-violations file, `--ignore-known` (default filename `.dependency-cruiser-known-violations.json`) silences only what's already recorded | H25-H31 |
| eslint-plugin-boundaries | Which "element type" (folder pattern) may import which other element type, entry-point-only access, external-package allowlists per element, unknown-file/unknown-dependency detection | ESLint, so editor-time and CI lint step | Medium-high: requires defining an explicit element taxonomy (`settings["boundaries/elements"]`) that matches the repo's real architecture before any rule is useful | None built in; relies on generic ESLint suppression (inline disable comments), no baseline/ratchet file format of its own | H32-H33 |
| oxlint | `import/no-cycle` (circular-import detection) and `eslint/no-restricted-imports` (path/pattern bans); no dedicated architecture-boundary rule | Rust-based linter binary; very fast, fits in CI or as a pre-commit gate alongside/instead of ESLint | Low: single binary, `.oxlintrc.json` toggles rules; but it cannot replace eslint-plugin-boundaries since it has no element-type concept | Not documented on the fetched rules page | H35 |
| TS project references | Which `composite` project's private source is visible to which other project; consumers only ever see the referenced project's `.d.ts` output | `tsc -b` (build orchestrator) and IDE project-aware navigation | High: every package needs `composite: true`, an explicit `references` array, and `declaration: true`; restructures the whole build pipeline around it | None: a reference either resolves and typechecks or it doesn't; no partial/known-violation mode | H19-H21 |
| pnpm strict linking (default, no `shamefully-hoist`) | That a package can only `require`/`import` a dependency it declares itself in its own `package.json` (blocks phantom-dependency access); `workspace:` protocol blocks resolving to a non-local package | pnpm's install-time `node_modules` layout; enforced by Node's own resolution at runtime, nothing to "run" separately | Zero: this is pnpm's default behavior | N/A: it's structural prevention, not a violation-reporting tool, so there is nothing to baseline | H9-H14 |

---

## 5. Can Vercel Workflow step files live in a workspace package outside `apps/worker/src`, and under what condition?

Yes, with two conditions that both come from primary sources, not inference:

1. **The file must sit inside (or be re-exported into) a directory the `workflow/nitro` module
   actually scans.** Discovery is not "anything reachable through imports": it is a directory
   list, defaulting to `workflows/` at the Nitro project root "and all layer source directories"
   (H45). A workspace package that is one of Nitro's configured layers, or whose `workflows/`
   subdirectory is added via the module's `dirs` option, satisfies this; a package that is neither
   a layer nor named in `dirs` does not get scanned even if it's a normal workspace dependency.
2. **The Nitro *project root* for this purpose is the pnpm workspace root (`workspaceDir`), not
   `apps/worker/src`.** H46: "Uses Nitro's `workspaceDir` as the workflow project root so monorepo
   apps can import sibling workspace packages without extra workflow config." That sentence is the
   entire content of `packages/nitro/README.md` on `vercel/workflow`'s `main` branch, and it is
   repeated verbatim in the published API reference (H45-H46). Practically: a `'use step'` function
   in `apps/shared/some-package/src/foo.ts` can be imported by an `apps/worker` workflow file and
   still get discovered/bundled correctly, because `workflow/nitro` resolves the whole workspace as
   one project, not just `apps/worker`.

What is not shown by any source fetched: whether `dirs` accepts a path like
`../shared/some-package/workflows` (a relative escape from the Nitro `rootDir`) or only paths
inside `rootDir`/`workspaceDir`'s own layer list. The docs describe the default and the
`workspaceDir` rooting, not the exact glob/escape semantics of a custom `dirs` entry.

---

## 6. What the sources do not say

1. **No stated glob/escape semantics for `workflow/nitro`'s `dirs` option.** Confirmed it exists and
   its default (H45); not confirmed whether an entry can point outside `workspaceDir`, or whether
   symlinked workspace packages are walked the same way as real directories.
2. **No monorepo-specific statement from Node.js itself.** `exports`/`imports`/conditions (H1-H8)
   are package-level rules with no awareness of workspaces; every workspace-specific behavior
   (H9-H18) comes from pnpm, not Node.
3. **No native "ratchet" or baseline feature in eslint-plugin-boundaries or oxlint.** Only
   dependency-cruiser documents a first-party baseline/known-violations workflow (H30-H31).
4. **No confirmation that the fetched `nitro.build/config` pages describe the exact `nitropack@2.13.4`
   this repo pins.** They document the current Nitro 3 line; H48-H49 record the concrete difference
   found by inspecting the published 2.13.4 package directly, but no page states a version-by-version
   changelog for `srcDir`; the deprecation date/version is not documented anywhere fetched.
5. **No pnpm statement about relative cross-package source imports.** pnpm's strictness (H9-H14) is
   entirely about the dependency-declaration graph inside `node_modules`; nothing in `pnpm.io`
   claims it blocks or permits `import ... from "../../other-app/src/x"`; that path never touches
   pnpm's linking layer at all, which is exactly why a separate boundary tool (§4) is needed.
6. **No first-party "world" page found.** `workflow-sdk.dev/docs/worlds` and `.../docs/concepts/world`
   both 404'd; the concept ("world" as a pluggable persistence backend, e.g. `@workflow/world-postgres`,
   present in this repo's `apps/worker/package.json` devDependencies) is referenced only in passing by
   the pricing page's Events section, not documented on a fetched page.
7. **No fetched Vercel Workflow "limitations" page.** `vercel.com/docs/workflows/limits` 404'd; the
   closest primary content is the numeric ceilings on `vercel.com/docs/workflows/pricing` (not given
   an H-number above, since these are quantitative limits rather than a boundary/contract rule): 25,000 events/run,
   10,000 steps/run, 50 MB max payload, 240s max workflow replay duration, 250 MB max total bundle size.
8. **No statement tying `isolatedDeclarations` or `verbatimModuleSyntax` specifically to monorepos.**
   Both are general TypeScript emit-correctness options (H22-H23); no fetched page frames them as a
   monorepo-boundary mechanism, though `isolatedDeclarations`'s stated purpose (per-file
   transpilation safety) is why a tool like esbuild/SWC-based bundling (as `@workflow/builders` uses,
   H44) benefits from it.

---

## Source list

1. https://nodejs.org/api/packages.html
2. https://pnpm.io/workspaces
3. https://pnpm.io/catalogs
4. https://pnpm.io/settings/peer-dependencies
5. https://pnpm.io/settings/node-modules
6. https://pnpm.io/cli/deploy
7. https://www.typescriptlang.org/docs/handbook/project-references.html
8. https://www.typescriptlang.org/tsconfig/ (plus per-option anchors: `#paths`, `#customConditions`, `#verbatimModuleSyntax`, `#isolatedDeclarations`, `#composite`)
9. https://www.typescriptlang.org/docs/handbook/modules/reference.html
10. https://github.com/sverweij/dependency-cruiser (README.md)
11. https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md
12. https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md
13. https://github.com/javierbrea/eslint-plugin-boundaries (README) and https://www.jsboundaries.dev/docs/rules/
14. jsdelivr package file listing for `eslint-plugin-boundaries@7.2.0` (https://data.jsdelivr.com/v1/packages/npm/eslint-plugin-boundaries@7.2.0)
15. https://typescript-eslint.io/rules/no-restricted-imports/
16. https://oxc.rs/docs/guide/usage/linter/rules.html
17. https://knip.dev/
18. https://vercel.com/docs/workflows
19. https://vercel.com/docs/workflows/concepts
20. https://vercel.com/docs/workflows/pricing
21. https://workflow-sdk.dev/docs/foundations/workflows-and-steps
22. https://workflow-sdk.dev/docs/foundations/serialization
23. https://workflow-sdk.dev/docs/api-reference/workflow-nitro
24. https://github.com/vercel/workflow/blob/main/packages/nitro/README.md
25. https://github.com/vercel/workflow/blob/main/packages/builders/README.md
26. https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md
27. https://github.com/vercel/workflow/blob/main/packages/nest/README.md
28. https://nitro.build/config (and `#workspacedir`, `#scandirs` anchors)
29. https://nitro.build/guide
30. https://raw.githubusercontent.com/nitrojs/nitro/main/src/types/config.ts (Nitro 3, `main` branch)
31. npm package `nitropack@2.13.4` (published tarball, `dist/shared/nitro.D682J6aL.d.mts`): this repo's pinned Nitro version
32. https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages
33. https://nextjs.org/docs/app/api-reference/config/typescript
34. https://workflow-sdk.dev/docs/worlds and https://workflow-sdk.dev/docs/concepts/world; both 404, recorded in §6
35. https://vercel.com/docs/workflows/limits; 404, recorded in §6

Repo files read (per task scope, not cited as external sources): `apps/worker/nitro.config.ts`,
`apps/worker/package.json`, `apps/shared/contracts/package.json`, `apps/worker/tsconfig.json`.
