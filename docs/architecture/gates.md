Status: current
Last-verified: 2026-09-23

# Delivery gates

The table below is every gate that can turn a pull request red. Most of its
rows are the static ladder, which `pnpm run gates` runs in table order. Two are
not: `engine-canary` is an on-demand job outside the required `ci` (it runs
only for a pull request labelled `run-canary` or a manual dispatch, and red on
it does not block a merge; ADR-004, change log 2026-09-23), and `Changelog
completeness` is a step of the `source-checks` job that runs on pull requests
only. Both name
their workflow in the `Script` column. A gate exits non-zero when its check
fails.

| Gate | Checks | Script | Fails when |
|---|---|---|---|
| Boundaries | Worker tier edges, unknown source paths, file cycles, and unlisted cross-cluster deep imports | `scripts/gates/boundaries.mjs` | A dependency crosses an unallowed edge, a path is unknown, a file cycle is found, or a deep import is unlisted |
| Unused code | Knip findings by workspace and category | `scripts/gates/unused-code.mjs` | Any finding is reported |
| Lint | Oxlint diagnostics for worker, dashboard, scripts, and packages | `scripts/gates/lint.mjs` | Any diagnostic is reported |
| UI primitives | Dashboard screens against the shared primitives and motion tokens, minus the documented-constraint allowlist | `scripts/gates/ui-primitives.mjs` | A screen uses a native control or a raw motion value instead of a shared primitive or token outside the allowlist, a dashboard source root or the allowlist is missing, or zero screen files are scanned |
| Resurrected paths | Retired paths using tracked and non-ignored files | `scripts/gates/no-resurrected-paths.mjs` | A retired path has a tracked or non-ignored file |
| Single schema | Retired workflow schema v1 spellings and production references | `scripts/gates/single-schema-version.mjs` | A retired schema branch, helper, type, or production test import is found |
| Transactions | Production worker source for `.transaction(` | `scripts/gates/transactions-in-repositories.mjs` | Any production transaction call is found |
| Consecutive writes | Awaited `db.insert`, `db.update`, `db.delete`, or `db.execute` calls in one non-repository production function | `scripts/gates/consecutive-writes.mjs` | A function contains two or more awaited database writes outside the repository tier and allowlist |
| Database client fence | Production worker reaches to `db/client`, Drizzle value imports, and schema value reachability, directly or through local barrels | `scripts/gates/db-client-fence.mjs` | Any production file reaches `db/client`, imports a Drizzle value, or reaches a schema value |
| Package contracts | Descriptions for every package under `packages/` | `scripts/gates/package-contracts.mjs` | A package has no non-empty description |
| Model catalog drift | Model literals outside the catalog's declared exclusions | `scripts/gates/model-catalog-drift.mjs` | A model identifier is duplicated outside an approved owner or exclusion |
| Dependency consistency | Shared dependency versions against the pnpm catalog | `scripts/gates/check-deps-consistency.mjs` | A shared dependency is not cataloged, is split across specifiers, or is missing from the catalog |
| Documentation status | Headers, freshness, status targets, and reachability for current documents; a passing run prints how many documents it checked and how many it skipped for frontmatter | `scripts/gates/docs-status.mjs` | A document header is invalid, a current document is stale or unreachable, a superseded target is missing, one of the paths the checked set is computed from is gone, or `docs/` holds no Markdown at all |
| engine-canary | Runs only on the `run-canary` label or a manual dispatch; by default the custom Haiku fixture, all three fixtures with `cases: all`. `scripts/ci/engine-canary-scope.ts` lists the changes that warrant the label: the deployed surfaces the canary drives, three directories of `apps/worker/src/services/**`, the canary's own runners and job, and the dependency inputs `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `apps/worker/package.json`; skips deployment when `apps/worker/drizzle/**` changes; exact deployment commit and declared production database identity on the `ai-workflow-demo` custom environment | `.github/workflows/engine-canary.yml`, `scripts/ci/engine-canary-scope.ts`, `scripts/ci/engine-canary-preflight.ts` | No target is declared, an armed target is incomplete, the target name is `production`, deployment identity is unproven, the database environment or fingerprint is mismatched, or a selected live canary fails |
| Changelog completeness | Whether a pull request touching `apps/**` or `packages/**` leaves an entry under `changelog/unreleased/` that yields at least one bullet, unless it carries the `changelog: skip` label | `scripts/ci/changelog-entry-gate.ts`, `.github/workflows/ci.yml` | A product change adds no entry, the entry it names is deleted, blank or carries no Markdown bullet, an entry cannot be read from the checkout, or the pull request's file list comes back empty |

A gate proves an invariant over a set, and an empty set proves nothing, so a
gate here refuses rather than passes when it finds nothing to look at: a path
it was told to scan is gone, or a scan comes back zero. The refusal names both
the path and the invariant it leaves unproven, and a passing gate prints how
much it scanned, so a green line can be read against a count. The one limit is
`Unused code`: Knip reports findings and never the size of what it read, so
that gate can anchor the workspaces its configuration declares and no more.
ADR-007 holds the rule and that limit; which paths each gate anchors lives in
that gate's source and never in this table.

The engine-canary gate is armed with `ENGINE_CANARY_TARGET=ai-workflow-demo`,
`ENGINE_CANARY_DB_ENV=production`, and the
`ENGINE_CANARY_DB_FINGERPRINT` reported by the target's `/health` response.
The Vercel token, production `DATABASE_URL`, protection bypass, and the OAuth
client id and secret live in GitHub's `e2e` environment. The client is
registered once by an owner with exactly `mcp:read runs:dispatch`; the job mints
a `client_credentials` token and calls the target's MCP tools. The three
deployed fixture definitions stay disabled and are dispatched directly against
one permanent Jira fixture, so the gate neither changes workflow enablement nor
carries a Jira credential. The demo Vercel environment retains the production
GitHub App credentials used by triggered workflows. By the owner's decision of
2026-09-14, the canaries write run and replay records to the production
database, and the normal manual dispatch lifecycle may move the permanent Jira
fixture. A pull request migration is skipped so the shared production database
is changed only after merge.

## Lint policy

The lint gate keeps correctness rules and cheap-to-satisfy rules hard. The
following rules are disabled globally because they measure code shape or would
make broad behavior-sensitive edits. All other rules remain enabled.

| Rule | Reason |
|---|---|
| `eslint/require-unicode-regexp` | The `u` flag changes escape semantics; a mass edit is risk without a defect. |
| `eslint/max-lines-per-function` | Function size is a shape metric tracked by the architecture plan. |
| `eslint/max-lines` | File size is a shape metric tracked by the architecture plan. |
| `eslint/max-depth` | Nesting depth is a shape metric tracked by the architecture plan. |
| `eslint/max-classes-per-file` | Class count per file is a shape metric tracked by the architecture plan. |
| `eslint/require-await` | Some async functions keep an interface-conformance boundary. |
| `eslint/no-await-in-loop` | Sequential awaits are deliberate in orchestration and step code. |
| `eslint/no-inline-comments` | Inline comments can document local intent and are not a defect signal. |
| `eslint/no-negated-condition` | Negated branches are sometimes the clearest equivalent control flow. |
| `unicorn/no-negated-condition` | The duplicate style rule has the same control-flow rationale. |
| `unicorn/no-array-callback-reference` | Callback references are valid when their supplied arguments match the callback contract. |
| `unicorn/consistent-function-scoping` | Nested helpers may intentionally close over local state or stay step-local. |
| `unicorn/no-array-sort` | Requiring `toSorted` would change copy semantics in existing call sites. |
| `unicorn/no-array-reverse` | Requiring `toReversed` would change copy semantics in existing call sites. |
| `unicorn/prefer-string-replace-all` | `replaceAll` needs global behavior and would change calls that intentionally replace once. |
| `eslint/sort-vars` | Declaration ordering is stylistic and a mass reorder adds noise. |
| `eslint/no-underscore-dangle` | Protocol and integration names may intentionally contain leading underscores. |
| `unicorn/prefer-top-level-await` | Top-level await changes module evaluation and lifecycle behavior. |

In test files, end-to-end files, test support, and `scripts/**`, these rules are
also disabled:

| Rule | Reason |
|---|---|
| `eslint/one-var` | Fixtures and test setup group related declarations for readability. |
| `eslint/no-use-before-define` | Test helpers and fixtures may be declared after the cases they support. |
| `eslint/no-magic-numbers` | Assertions and fixtures use literal values to pin expected behavior. |
| `unicorn/no-useless-undefined` | Mocks and assertions use explicit `undefined` to model omitted values. |
| `eslint/no-promise-executor-return` | Test promise helpers use executor returns to control mocked async behavior. |
| `unicorn/no-object-as-default-parameter` | Test fixtures use object defaults for concise case setup. |
| `eslint/no-shadow` | Nested test scopes reuse names to mirror fixture and context values. |

The override does not affect production source.

`eqeqeq` remains enabled with the narrow `null` exception so deliberate
nullish checks retain their behavior. Inline rule suppressions are exceptional;
each has to explain the behavior or test contract it preserves.
