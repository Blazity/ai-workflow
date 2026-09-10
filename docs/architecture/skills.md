Status: current
Last-verified: 2026-09-10

# Product skills

AI Workflow product skills are repository artifacts that an operator can add
to a harness profile. They use a `SKILL.md` document with YAML front matter,
may include supporting files, and become immutable artifacts identified by a
canonical SHA-256 hash. GitHub and deployment-local discovery both validate
the same manifest and artifact rules from `@shared/skills` before persistence.

## Repository location

Product skills live in the repository-root `skills/` directory. This location
is part of the application layout, not an instruction directory for a coding
assistant. It keeps one conventional product-skill path visible to GitHub
discovery, local development, and Nitro's function bundling. The worker copies
that directory into each function bundle and resolves it from the deployment
working directory.

Claude Code skills are development tooling for maintainers and live under
`.claude/skills/`. They can guide a Claude Code session working on this
repository, but AI Workflow does not offer them as deployment-local product
skills. Similar `SKILL.md` filenames do not make the two directories
interchangeable.

## Shared contract and source boundary

`@shared/skills` owns the product skill metadata parser, lock-file version 1
parser, portable artifact integrity rules, deterministic expected-hash drift
check, structured validation errors, and the operational `SkillSource`
interface. `SkillSource` has discovery and exact-snapshot read operations. The
persisted `HarnessSkillSource` union remains in `@shared/contracts` and has no
kind field because the complete source object participates in artifact hashing.

The shared package is browser-safe. It accepts an injected SHA-256 digest for
artifact operations and does not import Node APIs, filesystem code, provider
clients, database code, or environment configuration. GitHub access,
deployment-directory traversal, source-specific error presentation, refresh
coordination, and persistence remain worker responsibilities.

## Validation behavior

Every `SKILL.md` must be valid UTF-8 with YAML front matter. Its name uses
lowercase letters, digits, and hyphens. Its trimmed description contains 1 to
1024 characters. Artifact validation also requires safe unique relative paths,
mode 0644 or 0755, canonical base64, bounded file and total sizes, matching
per-file hashes, exactly one mode-0644 `SKILL.md`, matching metadata, and a
matching aggregate hash.

GitHub discovery skips malformed candidates, while importing a selected
candidate rejects it. Local discovery reports every skipped directory, and the
deployment validation command fails if any intended local skill cannot ship.
Both source reads expose the same package error code and reason before their
worker adapters add source context. Both also use the same deterministic
expected-hash comparison before a resolved artifact is trusted.

`apps/worker/skills-lock.json` is an external skills CLI lock artifact. Version
1 records `source`, `sourceType`, and `computedHash` for each named entry. The
repository history and current code identify no runtime producer or consumer.
The shared parser validates its format in package tests, while the worker's
sandbox diagnostic only prints the file. It does not pin product skills under
the repository-root `skills/` directory.
