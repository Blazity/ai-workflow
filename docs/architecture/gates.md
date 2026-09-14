Status: current
Last-verified: 2026-09-14

# Delivery gates

`pnpm run gates` runs the static gates below in table order. The
`engine-canary` row is a path-scoped CI gate outside that local ladder. A gate
exits non-zero when its check fails.

| Gate | Checks | Script | Fails when |
|---|---|---|---|
| Boundaries | Worker tier edges, unknown source paths, file cycles, and unlisted cross-cluster deep imports | `scripts/gates/boundaries.mjs` | A dependency crosses an unallowed edge, a path is unknown, a file cycle is found, or a deep import is unlisted |
| Unused code | Knip findings by workspace and category | `scripts/gates/unused-code.mjs` | Any finding is reported |
| Lint | Oxlint diagnostics for worker, dashboard, scripts, and packages | `scripts/gates/lint.mjs` | Any diagnostic is reported |
| Resurrected paths | Retired paths using tracked and non-ignored files | `scripts/gates/no-resurrected-paths.mjs` | A retired path has a tracked or non-ignored file |
| Single schema | Retired workflow schema v1 spellings and production references | `scripts/gates/single-schema-version.mjs` | A retired schema branch, helper, type, or production test import is found |
| Transactions | Production worker source for `.transaction(` | `scripts/gates/transactions-in-repositories.mjs` | Any production transaction call is found |
| Consecutive writes | Awaited `db.insert`, `db.update`, `db.delete`, or `db.execute` calls in one non-repository production function | `scripts/gates/consecutive-writes.mjs` | A function contains two or more awaited database writes outside the repository tier and allowlist |
| Database client fence | Production worker reaches to `db/client`, Drizzle value imports, and schema value reachability, directly or through local barrels | `scripts/gates/db-client-fence.mjs` | Any production file reaches `db/client`, imports a Drizzle value, or reaches a schema value |
| Package contracts | Descriptions for every package under `packages/` | `scripts/gates/package-contracts.mjs` | A package has no non-empty description |
| Model catalog drift | Model literals outside the catalog's declared exclusions | `scripts/gates/model-catalog-drift.mjs` | A model identifier is duplicated outside an approved owner or exclusion |
| Dependency consistency | Shared dependency versions against the pnpm catalog | `scripts/gates/check-deps-consistency.mjs` | A shared dependency is not cataloged, is split across specifiers, or is missing from the catalog |
| Documentation status | Headers, freshness, status targets, and reachability for current documents | `scripts/gates/docs-status.mjs` | A document header is invalid, a current document is stale or unreachable, or a superseded target is missing |
| engine-canary | Pull request changes under `apps/worker/src/engine/**`, `apps/worker/src/db/**`, or `packages/**`; idle with a green warning when no target is declared; skips deployment when `apps/worker/drizzle/**` changes; exact deployment commit and declared production database identity on the `ai-workflow-demo` custom environment | `.github/workflows/ci.yml`, `scripts/ci/engine-canary-scope.ts`, `scripts/ci/engine-canary-preflight.ts` | An armed target is incomplete, the target name is `production`, deployment identity is unproven, the database environment or fingerprint is mismatched, or either live canary fails |

The gate is armed with `ENGINE_CANARY_TARGET=ai-workflow-demo`,
`ENGINE_CANARY_DB_ENV=production`, and the
`ENGINE_CANARY_DB_FINGERPRINT` reported by the target's `/health` response.
The Vercel token, production `DATABASE_URL`, Jira token, canary session token,
and the other canary credentials live in GitHub's `e2e` environment. The demo
Vercel environment retains the production GitHub App credentials used by
triggered workflows. By the owner's decision of 2026-09-14, the canaries write
to the production database, create run records under the trigger owner, and
create, move, and delete Jira tickets. A pull request migration is skipped so
the shared production database is changed only after merge.

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
