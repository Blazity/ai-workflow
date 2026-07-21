# Live prompt references

## Goal

Allow workflow prompt text to include a versioned prompt-library reference instead of a copied body. References follow the library head by default, can be pinned to an immutable version, expand recursively before global run variables, and remain reproducible within one run.

## Reference syntax

Prompt markdown uses a dedicated namespace that cannot collide with global `{{snake_case}}` run variables:

- `{{prompt:42}}` — prompt id 42, latest version;
- `{{prompt:42@2}}` — prompt id 42, pinned version 2.

The editor renders these tokens as named reference cards/chips using library metadata. Numeric ids remain stable across prompt renames inside the existing shared database. Malformed `prompt:` directives fail validation rather than reaching an agent verbatim.

## Runtime resolution

After the workflow definition is loaded, one durable step resolves every reference in every prompt-bearing node parameter. `latest` is converted to a concrete version in this step, so retries and resumed execution of the same run reuse the step result. The resolved nodes, not the stored definition, are then passed to the graph interpreter.

Resolution order is:

1. recursively expand prompt references;
2. retain a manifest of requested and resolved versions;
3. substitute global per-run variables immediately before each block executes;
4. pass the final text to the block.

Global variable values are opaque and are never recursively reparsed. A referenced prompt containing `{{branch_name}}` works because the reference is expanded before the existing global substitution pass. A generated value containing `{{branch_name}}` does not trigger another substitution.

The resolver rejects missing prompts/versions, latest references to archived prompts, cycles, excessive nesting, and excessive expanded output. Pinned versions of archived prompts remain executable for reproducibility.

## Run audit

The first run telemetry write stores a prompt manifest containing prompt id/name, requested selector, concrete resolved version, and body hash. A new run may resolve `latest` to a newer version; one existing run never changes its resolved body.

## Editor behavior

Whole-prompt library insertion creates a reference, with `Latest` as the primary action and the selected historical version available as `Pin vN`. A reference is read-only until detached; detaching replaces the token with the currently previewed body and restores ordinary editing. Individual-section insertion remains a copied markdown snapshot because sections do not have stable cross-version ids.

The expanded section composer treats a whole-prompt reference as one atomic block. Dragging the block reorders the reference without expanding it into independently editable cards. Raw mode exposes the canonical token.

## Compatibility

Existing workflows containing copied prompt bodies and informational `promptRefs` continue to run unchanged. `promptRefs` retains its provenance role for copied text; live execution semantics belong to namespaced reference tokens and the run resolver.

## Verification

- Parser/formatter tests cover latest, explicit latest, pinned, multiple, and malformed tokens.
- Resolver tests cover nested references, global variables left intact, cache behavior, cycles, missing data, archived latest/pinned behavior, depth, and output limits.
- Workflow tests prove resolution happens before variable substitution and a run uses one concrete version.
- Telemetry tests prove the manifest is stored without being erased by later writers.
- Dashboard tests cover token insertion, pinning, detaching, and reference display.
