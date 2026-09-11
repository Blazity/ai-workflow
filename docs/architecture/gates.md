Status: current
Last-verified: 2026-09-11

# Delivery gates

`pnpm run gates` runs the gates below in this order. A gate exits non-zero and
stops the ladder when its check fails.

| Gate | Checks | Script | Fails when |
|---|---|---|---|
| Boundaries | Worker tier edges, unknown source paths, file-cycle growth, and unlisted cross-cluster deep imports | `scripts/gates/boundaries.mjs` | A dependency crosses an unallowed edge, a path is unknown, a cycle count grows, or a new deep import is found |
| Unused code | Knip findings by workspace and category | `scripts/gates/unused-code.mjs` | A finding is above its current ratchet |
| Lint | Oxlint diagnostics for worker, dashboard, scripts, and packages | `scripts/gates/lint.mjs` | A correctness error or warning is above its current ratchet, or a rule with a zero baseline reports a diagnostic |
| Resurrected paths | Retired paths using tracked and non-ignored files | `scripts/gates/no-resurrected-paths.mjs` | A retired path has a tracked or non-ignored file |
| Single schema | Retired workflow schema v1 spellings and production references | `scripts/gates/single-schema-version.mjs` | A retired schema branch, helper, type, or production test import is found |
| Transactions | Production worker source for `.transaction(` | `scripts/gates/transactions-in-repositories.mjs` | Any production transaction call is found |
| Consecutive writes | Awaited `db.insert`, `db.update`, `db.delete`, or `db.execute` calls in one non-repository production function | `scripts/gates/consecutive-writes.mjs` | A function contains two or more awaited database writes outside the repository tier and allowlist |
| Database client fence | Direct or local-barrel reaches from production worker files to `db/client` | `scripts/gates/db-client-fence.mjs` | A file reaches `db/client` above its current ratchet |
| Package contracts | Descriptions for every package under `packages/` | `scripts/gates/package-contracts.mjs` | A package has no non-empty description |
| Model catalog drift | Model literals outside the catalog's declared exclusions | `scripts/gates/model-catalog-drift.mjs` | A model identifier is duplicated outside an approved owner or exclusion |
| Dependency consistency | Shared dependency versions against the pnpm catalog | `scripts/gates/check-deps-consistency.mjs` | A shared dependency is not cataloged, is split across specifiers, or is missing from the catalog |
| Documentation status | Headers, freshness, status targets, and reachability for current documents | `scripts/gates/docs-status.mjs` | A document header is invalid, a current document is stale or unreachable, or a superseded target is missing |

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

## In flight (stage 11)

At the end of this phase, the GATES-owned ratchets still above zero are:

| Ratchet | Remaining count | Phase 2 |
|---|---:|---|
| Lint correctness errors in worker production source | 25 | Remove `scripts/gates/lint.baseline.json` after the worker remainder is fixed |
| Lint warnings in worker production source | 183 | Remove `scripts/gates/lint.baseline.json` after the worker remainder is fixed |
| Knip worker files | 7 | Remove `scripts/gates/unused-code.baseline.json` after the worker remainder is fixed |
| Knip worker dependencies | 2 | Remove `scripts/gates/unused-code.baseline.json` after the worker remainder is fixed |
| Knip worker devDependencies | 1 | Remove `scripts/gates/unused-code.baseline.json` after the worker remainder is fixed |
| Knip worker exports | 113 | Remove `scripts/gates/unused-code.baseline.json` after the worker remainder is fixed |
| Knip worker types | 78 | Remove `scripts/gates/unused-code.baseline.json` after the worker remainder is fixed |

Dashboard, root, packages, worker tests, end-to-end files, test support, and
the scripts in this phase have no remaining lint or Knip findings. The worker
production findings remain ratcheted until the worker production lanes finish.
