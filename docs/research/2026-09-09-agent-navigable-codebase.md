# What Anthropic actually publishes about agent-navigable codebases

Primary-source research, 2026-09-09. Question: how does Anthropic say a codebase and its
documentation should be structured so Claude Code navigates it reliably and cheaply?

## 1. Scope and method

### What counts as primary here

* `code.claude.com/docs/*` (Claude Code product docs). Note: `docs.claude.com/en/docs/claude-code/*`
  now 301-redirects here, and `docs.anthropic.com/en/docs/agents-and-tools/agent-skills/*`
  302-redirects to `platform.claude.com/docs/en/agents-and-tools/agent-skills/*`. Both old paths
  still appear in search results, so cite the new canonical hosts.
* `platform.claude.com/docs/*` (Claude Platform docs, including the Agent Skills spec).
* `anthropic.com/engineering/*` (Anthropic engineering blog).
* `claude.com/blog/*` (Claude product blog, Anthropic-owned).
* `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` (first-party changelog).
* `agents.md` (first-party spec, but NOT Anthropic. Flagged wherever cited.)
* Local first-party artifacts on this machine:
  `~/.claude/plugins/cache/claude-plugins-official/skill-creator/*/skills/skill-creator/SKILL.md`,
  shipped by Anthropic through the `claude-plugins-official` marketplace.

### What was searched

Fetched in full: `/docs/en/memory`, `/docs/en/skills`, `/docs/en/large-codebases`,
`/docs/en/sub-agents`, `/docs/en/features-overview`, `/docs/en/context-window`,
`/docs/en/best-practices`, `/docs/en/hooks` on `code.claude.com`; the Agent Skills authoring
best-practices page on `platform.claude.com`; two engineering posts; one Claude blog post;
`agents.md`; the Claude Code changelog (6419 lines, grepped).

### Excluded

No Medium, dev.to, YouTube, Reddit or third-party write-up is cited. Where a claim exists only
in a secondary source, it is not in this document at all.

### Reading the tables

**Hard rule** means the docs state a mechanism Claude Code executes: a filename it reads, an
order it loads in, a numeric cap it enforces. **Recommendation** means Anthropic advises it
("we recommend", "keep it under", "target"). Adherence to a recommendation is not enforced.

---

## 2. Hard rules

| # | Rule | Exact quote | Source |
|---|------|-------------|--------|
| H1 | Claude Code does not read AGENTS.md | "Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If your repository already uses `AGENTS.md` for other coding agents, create a `CLAUDE.md` that imports it so both tools read the same instructions without duplicating them." | https://code.claude.com/docs/en/memory |
| H2 | Four CLAUDE.md scopes, fixed load order | "The table below lists them in load order, from broadest scope to most specific, so a project instruction appears in context after a user instruction." Scopes: Managed policy, User instructions (`~/.claude/CLAUDE.md`), Project instructions (`./CLAUDE.md` or `./.claude/CLAUDE.md`), Local instructions (`./CLAUDE.local.md`). | https://code.claude.com/docs/en/memory |
| H3 | Ancestors load at launch, descendants load lazily | "CLAUDE.md and CLAUDE.local.md files in the directory hierarchy above the working directory are loaded at launch. Files in subdirectories load on demand when Claude reads files in those directories." | https://code.claude.com/docs/en/memory |
| H4 | Memory files concatenate, they do not override | "All discovered files are concatenated into context rather than overriding each other. Across the directory tree, content is ordered from the filesystem root down to your working directory." | https://code.claude.com/docs/en/memory |
| H5 | Import syntax and depth cap | "CLAUDE.md files can import additional files using `@path/to/import` syntax... Imported files can recursively import other files, with a maximum depth of four hops." | https://code.claude.com/docs/en/memory |
| H6 | Imports do not save context | "Splitting into `@path` imports helps organization but doesn't reduce context, since imported files load at launch." | https://code.claude.com/docs/en/memory |
| H7 | Backticks disable an import | "Import parsing skips Markdown code spans and fenced code blocks. To mention a path in your CLAUDE.md without importing it, wrap it in backticks." | https://code.claude.com/docs/en/memory |
| H8 | Hard CLAUDE.md size ceiling | "Claude Code loads a CLAUDE.md file of up to 4 MiB in full and skips a larger file." | https://code.claude.com/docs/en/memory |
| H9 | CLAUDE.md is a user message, not the system prompt | "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself. Claude reads it and tries to follow it, but there's no guarantee of strict compliance." | https://code.claude.com/docs/en/memory |
| H10 | HTML comments are stripped before injection | "Block-level HTML comments (`<!-- maintainer notes -->`) in CLAUDE.md files are stripped before the content is injected into Claude's context." | https://code.claude.com/docs/en/memory |
| H11 | `.claude/rules/` exists and loads recursively | "Place markdown files in your project's `.claude/rules/` directory... All `.md` files are discovered recursively." Rules without `paths` frontmatter "are loaded at launch with the same priority as `.claude/CLAUDE.md`." | https://code.claude.com/docs/en/memory |
| H12 | Path-scoped rules trigger on file reads | "Path-scoped rules trigger when Claude reads files matching the pattern, not on every tool use." | https://code.claude.com/docs/en/memory |
| H13 | `claudeMdExcludes` skips memory files by glob | "The `claudeMdExcludes` setting lets you skip specific files by path or glob pattern... Patterns are matched against absolute file paths using glob syntax." Managed policy CLAUDE.md "cannot be excluded". | https://code.claude.com/docs/en/memory |
| H14 | `additionalDirectories` never loads instructions | Table: `additionalDirectories` setting loads CLAUDE.md and rules "Never", loads skills "Never". `--add-dir` loads CLAUDE.md "Only with the environment variable below" (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`) and loads skills "Yes". | https://code.claude.com/docs/en/large-codebases |
| H15 | Starting directory decides what loads | Table: starting from repository root loads "Root only; subdirectory files load on demand when Claude reads there"; starting from a subdirectory loads "That directory's plus every ancestor's". | https://code.claude.com/docs/en/large-codebases |
| H16 | Project settings do not inherit up the tree | "Project settings in `.claude/settings.json` aren't inherited from parent directories the way CLAUDE.md files are." | https://code.claude.com/docs/en/large-codebases |
| H17 | SKILL.md filename and locations are fixed | Personal `~/.claude/skills/<skill-name>/SKILL.md`, project `.claude/skills/<skill-name>/SKILL.md`, nested `<subdir>/.claude/skills/<skill-name>/SKILL.md`, plugin `<plugin>/skills/<skill-name>/SKILL.md`. | https://code.claude.com/docs/en/skills |
| H18 | Frontmatter must be the first line | "Claude Code reads the frontmatter only when the opening `---` is the file's first line. Otherwise it treats the whole file, `---` markers included, as skill content." | https://code.claude.com/docs/en/skills |
| H19 | Skill frontmatter validation limits | "`name`: Maximum 64 characters, lowercase letters/numbers/hyphens only, no XML tags, no reserved words"; "`description`: Maximum 1,024 characters, non-empty, no XML tags". | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices |
| H20 | Skill listing is truncated under a budget | "The listing always contains every skill name, but if you have many skills, Claude Code shortens descriptions to fit the listing's character budget... The budget scales at 1% of the model's context window." | https://code.claude.com/docs/en/skills |
| H21 | Three levels of progressive disclosure | Metadata is "the **first level** of _progressive disclosure_"; the SKILL.md body is "the **second level** of detail"; linked files are "the **third level** (and beyond) of detail, which Claude can choose to navigate and discover only as needed." | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills |
| H22 | Nested skills load lazily, on file access | "Skills in a `.claude/skills/` directory below where you started don't load at startup. They load the first time Claude reads or edits a file in that subdirectory and stay available for the rest of the session." | https://code.claude.com/docs/en/skills |
| H23 | Nested skill name collision is path-qualified | "on a name clash, the nested skill appears as `<dir>:<name>` so both stay available" (changelog v2.1.178). Docs: "`/apps/web:deploy` runs the nested skill on its own." | https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md and https://code.claude.com/docs/en/skills |
| H24 | Parent-directory skills load at startup | "Claude Code loads project skills from `.claude/skills/` in the directory where you start it and in every parent directory up to the repository root, so starting in `packages/frontend/` still picks up skills defined at the root." | https://code.claude.com/docs/en/skills |
| H25 | Subagents get CLAUDE.md, not auto memory | Non-fork subagent context contains "**CLAUDE.md files**: every level of the CLAUDE.md hierarchy the main conversation loads". But: "**Auto memory**: the main conversation's auto memory isn't loaded." | https://code.claude.com/docs/en/sub-agents |
| H26 | Explore and Plan skip CLAUDE.md entirely | "Explore and Plan skip your CLAUDE.md files and the parent session's git status to keep research fast and inexpensive." And: "There is no frontmatter field or per-agent setting to change which agents skip them." | https://code.claude.com/docs/en/sub-agents |
| H27 | Subagent descriptions have a warning threshold | "When the combined descriptions of your subagents, except the built-in ones, exceed 15,000 tokens, Claude Code shows a warning at startup with the total token count." | https://code.claude.com/docs/en/sub-agents |
| H28 | Subagent definition locations and priority | Managed settings (1, highest), `--agents` CLI flag (2), `.claude/agents/` (3), `~/.claude/agents/` (4), plugin `agents/` (5, lowest). Identity "comes only from the `name` frontmatter field". | https://code.claude.com/docs/en/sub-agents |
| H29 | Compaction re-injects some memory, not all | Table: project-root CLAUDE.md and unscoped rules are "Re-injected from disk"; rules with `paths:` frontmatter and nested CLAUDE.md are reloaded only "as Claude reads files" that match; invoked skill bodies are "Re-injected, capped at 5,000 tokens per skill and 25,000 tokens total; oldest dropped first". | https://code.claude.com/docs/en/context-window |
| H30 | Skill truncation keeps the top of the file | "Truncation keeps the start of the file, so put the most important instructions near the top of `SKILL.md`." | https://code.claude.com/docs/en/context-window |
| H31 | Auto memory index read limit | "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation. Content beyond that threshold is not loaded at session start." | https://code.claude.com/docs/en/memory |
| H32 | Hooks are the only enforcement layer | "Settings rules are enforced by the client regardless of what Claude decides to do. CLAUDE.md instructions shape Claude's behavior but are not a hard enforcement layer." | https://code.claude.com/docs/en/memory |
| H33 | An instruction-loading hook event exists | `InstructionsLoaded`: "When a CLAUDE.md or `.claude/rules/*.md` file is loaded into context. Fires at session start and when files are lazily loaded during a session". Added in v2.1.69. | https://code.claude.com/docs/en/hooks |
| H34 | Hooks merge, they do not override | "**Hooks** merge: all registered hooks fire for their matching events regardless of source." | https://code.claude.com/docs/en/features-overview |
| H35 | Content search already respects .gitignore | "Claude's content searches respect `.gitignore` by default, so paths already listed there, such as `node_modules/`, `dist/`, and `build/`, stay out of search results without additional configuration." | https://code.claude.com/docs/en/large-codebases |
| H36 | Read deny rules leak through shell recursion | "A Bash search such as `grep -r` or `find` over a directory that contains denied files still includes them in its output." | https://code.claude.com/docs/en/large-codebases |
| H37 | Sparse worktrees always include root files | "Root-level files like `package.json`, `tsconfig.base.json`, and lock files are always checked out alongside the directories you list. Root-level directories are not, so include `.claude` in the list." | https://code.claude.com/docs/en/large-codebases |
| H38 | Non-Anthropic: nearest AGENTS.md wins | "Agents automatically read the nearest file in the directory tree, so the closest one takes precedence and every subproject can ship tailored instructions." Note: this is the agents.md spec's rule for agents that implement it. Claude Code is not one of them (see H1). | https://agents.md/ |

---

## 3. Recommendations Anthropic makes

Advisory. Nothing enforces these.

### CLAUDE.md sizing and content

* "**Size**: target under 200 lines per CLAUDE.md file. Longer files consume more context and
  reduce adherence." (https://code.claude.com/docs/en/memory)
* "Keep it concise. For each line, ask: *Would removing this cause Claude to make mistakes?* If
  not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!"
  (https://code.claude.com/docs/en/best-practices)
* The include/exclude table (https://code.claude.com/docs/en/best-practices). Include: "Bash
  commands Claude can't guess", "Code style rules that differ from defaults", "Repository
  etiquette (branch naming, PR conventions)", "Architectural decisions specific to your project",
  "Developer environment quirks (required env vars)", "Common gotchas or non-obvious behaviors".
  Exclude: "Anything Claude can figure out by reading code", "Detailed API documentation (link to
  docs instead)", "Information that changes frequently", "Long explanations or tutorials",
  "File-by-file descriptions of the codebase".
* "If an entry is a multi-step procedure or only matters for one part of the codebase, move it to
  a skill or a path-scoped rule instead." (https://code.claude.com/docs/en/memory)
* "Keep CLAUDE.md under 200 lines, give it an owner, and review changes to it like code"
  (https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more)
* Emphasis is a scarce resource: "If Claude keeps skipping one instruction, add emphasis such as
  IMPORTANT to that line alone. If you emphasize many lines, none of them stands out."
  (https://code.claude.com/docs/en/best-practices)
* `/doctor` proposes trims for a checked-in CLAUDE.md, "cutting content Claude could derive from
  the codebase" (changelog v2.1.206).

### Monorepo layout

* The canonical example tree (https://code.claude.com/docs/en/large-codebases):
  root `CLAUDE.md`, then `packages/api/CLAUDE.md` + `packages/api/.claude/skills/`,
  `packages/web/CLAUDE.md` + `packages/web/.claude/skills/`, `packages/shared/CLAUDE.md`.
* "A common split is two levels: **Root `CLAUDE.md`**: instructions that apply everywhere...
  **Per-subdirectory `CLAUDE.md`**: conventions specific to that area's stack."
* "In monorepos, give each team's directory its own subdirectory CLAUDE.md so teams only load
  their own conventions" (https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more)
* Per-directory CLAUDE.md vs path-scoped rule: use the former when "Directory owners maintain
  their own conventions; instructions are versioned with the code"; use the latter when "You want
  all conventions in one place, or the same rule applies to many scattered paths."
* Keep files current: "Review in pull requests", "Revisit after major model releases", "Add a
  Stop hook that proposes updates".
* When layering stops scaling, move conventions into plugins or MCP: "Per-directory CLAUDE.md
  files can become hard to govern as the codebase grows. Conventions drift, files go stale, and
  no one owns the root."

### Skills

* "Keep `SKILL.md` under 500 lines. Move detailed reference material to separate files."
  (https://code.claude.com/docs/en/skills and the identical rule at
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
* "**Keep references one level deep from SKILL.md**. All reference files should link directly
  from SKILL.md to ensure Claude reads complete files when needed." Deep nesting causes partial
  reads: "Claude might use commands like `head -100` to preview content rather than reading
  entire files, resulting in incomplete information."
* "For reference files longer than 100 lines, include a table of contents at the top."
* "**Name files descriptively:** Use names that indicate content: `form_validation_rules.md`, not
  `doc2.md`"; "**Organize for discovery:** Structure directories by domain or feature. Good:
  `reference/finance.md`, `reference/sales.md`. Bad: `docs/file1.md`, `docs/file2.md`"
* Descriptions: "Always write in third person"; include "both what the Skill does and when to use
  it"; "Keep descriptions short and lead with words a request would contain, like writing or
  modifying tests in `packages/api/`."
* Naming: "Consider using **gerund form** (verb + -ing) for Skill names". Avoid "Vague names:
  `helper`, `utils`, `tools`".
* Match specificity to fragility: high freedom for open problems, low freedom ("Run exactly this
  script") for fragile ones.
* "Bundle comprehensive resources: Include complete API docs, extensive examples, large datasets;
  no context penalty until accessed."
* Skill vs CLAUDE.md, verbatim rule of thumb: "**Put it in CLAUDE.md** if Claude should always
  know it... **Put it in a skill** if it's reference material Claude needs sometimes (API docs,
  style guides) or a workflow you trigger with `/<name>`."
  (https://code.claude.com/docs/en/features-overview)

### Subagents and context

* "Since context is your fundamental constraint, use subagents to keep research out of it."
  (https://code.claude.com/docs/en/best-practices)
* "**The infinite exploration.** You ask Claude to investigate something without scoping it.
  Claude reads hundreds of files, filling the context. **Fix**: Scope investigations narrowly or
  use subagents so the exploration doesn't consume your main context."
* "Each subagent might explore extensively, using tens of thousands of tokens or more, but returns
  only a condensed, distilled summary of its work."
  (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
* "Context, therefore, must be treated as a finite resource with diminishing marginal returns."
  (same source)
* "Letting agents navigate and retrieve data autonomously also enables progressive disclosure"
  and "Folder hierarchies, naming conventions, and timestamps all provide important signals that
  help both humans and agents understand how and when to utilize information." (same source).
  This is the closest Anthropic comes to a general statement about repository layout for agents.
* Adoption order (https://code.claude.com/docs/en/features-overview): convention wrong twice goes
  to CLAUDE.md; a playbook pasted a third time becomes a skill; a side task that floods the
  conversation goes to a subagent; "You want something to happen every time without asking" goes
  to a hook; "A second repository needs the same setup" goes to a plugin.

### Cost controls specific to large repos

* Per-directory skills, `claudeMdExcludes`, `Read` deny rules under `permissions.deny`, a code
  intelligence (LSP) plugin, `worktree.sparsePaths` plus `symlinkDirectories`, and
  `additionalDirectories` / `--add-dir`. All from https://code.claude.com/docs/en/large-codebases.
* "This pairs well with `claudeMdExcludes` and the `Read` deny rules above. Those keep irrelevant
  content out of context, and code intelligence keeps Claude from reading through what remains to
  locate a definition."

---

## 4. What Anthropic does not say

Findings, not gaps to fill with invention.

1. **No prescribed `docs/` layout.** No Anthropic page states how prose documentation inside a
   repository should be named, foldered, or indexed for an agent. The only naming and structure
   advice is scoped to files inside a *skill directory* (see the `reference/finance.md` guidance
   above), not to the repository's own `docs/`. Anything claiming an official `docs/` convention
   for Claude Code is unsourced.
2. **No README.md role.** The docs mention `@README` only as an import example. Claude Code has
   no documented special handling of `README.md`.
3. **No AGENTS.md support and no roadmap for it.** H1 is the whole story. `AGENTS.md` appears
   0 times in the Claude Code changelog (6419 lines, checked 2026-09-09). The only first-party
   bridges are the `@AGENTS.md` import, a symlink, `/init` under `CLAUDE_CODE_NEW_INIT=1`, and
   the one-time `/import` copy.
4. **No documented precedence between conflicting CLAUDE.md files.** The mechanism is
   concatenation (H4), and resolution is left to the model: "When instructions conflict, Claude
   uses judgment to reconcile them, with more specific instructions typically taking precedence"
   (https://code.claude.com/docs/en/features-overview) and "If two rules contradict each other,
   Claude may pick one arbitrarily" (https://code.claude.com/docs/en/memory). There is no
   deterministic last-wins guarantee. Do not design around one.
5. **No enforced CLAUDE.md size limit below 4 MiB.** The 200-line figure is a target, never a
   cap. Nothing rejects a 900-line file.
6. **No stated cost of a nested CLAUDE.md that never loads.** The docs say subdirectory files
   load on demand, but give no token accounting for how many nested files a root-started session
   accumulates over a long run, beyond the warning that root-started skill discovery "can
   accumulate into the hundreds".
7. **No guidance on package boundaries as a code-design question.** Everything Anthropic
   publishes about monorepos is about *configuration placement* (which file in which directory),
   not about how to draw module seams, name exports, or size a package so an agent can navigate
   it. Claims that Anthropic recommends a particular module granularity are unsupported.
8. **No official CLAUDE.md template or schema.** "There's no required format for CLAUDE.md files,
   but keep it short and human-readable." (https://code.claude.com/docs/en/best-practices)
9. **No stated interaction between `.claude/rules/` and per-package directories in a monorepo
   beyond the comparison table.** Rules live in a "Central `.claude/` at the repo root"; whether
   `apps/worker/.claude/rules/` is discovered is only implied by the changelog entry about
   "nested `.claude/rules/*.md` files" (v2.1.211 era) and by H11's recursive discovery, not
   stated as a monorepo pattern.

---

## 5. Implications for this repo

Current state (2026-09-09): root `CLAUDE.md` is 1 line (`@AGENTS.md`), root `AGENTS.md` is 105
lines, `docs/` holds roughly 20 prose files and subdirectories, `skills/` sits at the repo root
outside `.claude/`, and neither `apps/worker`, `apps/dashboard` nor `apps/shared` carries its own
memory file.

### What is already right

* The `CLAUDE.md` -> `@AGENTS.md` import is exactly the documented bridge (H1). Keep it. Note H6:
  the import saves nothing in tokens, so the 105 lines of `AGENTS.md` are paid every session.
* 105 lines is inside the 200-line target.

### What the sources imply we should change

1. **Per-app `CLAUDE.md` files are the documented pattern we are not using.** The canonical tree
   at https://code.claude.com/docs/en/large-codebases maps one to one onto
   `apps/worker/CLAUDE.md` (Nitro, sandbox, migrations, the 300 s invocation ceiling),
   `apps/dashboard/CLAUDE.md` (Next.js), `apps/shared/CLAUDE.md`. Under H3 these cost nothing at
   launch from the root and load only when Claude touches that app. Anything currently in
   `AGENTS.md` that is worker-only or dashboard-only belongs there instead.
2. **Two skill trees exist and only one of them is a Claude Code skill tree.** `.claude/skills/`
   is the documented project location (H17) and loads. The separate top-level
   `skills/ai-workflow-review/` is not a location Claude Code scans: H17 lists personal, project,
   nested and plugin paths only. If those files are meant to be product-side workflow skills,
   fine. If they were meant for Claude Code, they never load.
3. **`.claude/learnings.md` (56 KB) is loaded by nothing.** Claude Code reads `.claude/CLAUDE.md`
   and `.claude/rules/*.md` (H2, H11). A bare `.claude/learnings.md` matches neither, so it is
   inert unless something imports or reads it. Either move it under `.claude/rules/` with `paths:`
   frontmatter, turn it into a skill, or accept that it is human-only documentation.
4. **`docs/` is where our verification and gate procedure should NOT live for agent purposes.**
   `AGENTS.md` already points at `docs/delivery-gates.md` for the gate ladder, which matches the
   "link to docs instead" advice. But under the CLAUDE.md-vs-skill rule, a multi-step procedure
   that Claude must execute (the gate ladder, the release flow) is skill-shaped, not doc-shaped:
   a skill body loads on demand and a doc only loads if Claude decides to read it. Note that
   Anthropic prescribes nothing about `docs/` itself (finding 4.1), so the choice is ours.
5. **`verify:changed` should probably be a hook, not a sentence.** H32 and the blog are blunt:
   "an instruction is the wrong tool" when something must not happen. `AGENTS.md` already
   acknowledges the gate is "advisory and bypassable". A `Stop` or `PreToolUse` hook makes it
   deterministic without spending context.
6. **`permissions.deny` for `Read` on generated output.** We have `node_modules` covered by
   `.gitignore` (H35), but any checked-in generated code or `_archive-*` bundles are not, and
   H36 warns that a Bash `grep -r` still surfaces denied paths, which is directly relevant given
   this repo's `rtk`-wrapped shell usage.
7. **Per-app skills over one root skill pile.** With per-directory skills, "Neither directory's
   skills load during the other's tasks." With everything at the root, every description competes
   inside the 1% listing budget (H20) and gets truncated.

---

## Source list

1. https://code.claude.com/docs/en/memory
2. https://code.claude.com/docs/en/skills
3. https://code.claude.com/docs/en/large-codebases
4. https://code.claude.com/docs/en/sub-agents
5. https://code.claude.com/docs/en/features-overview
6. https://code.claude.com/docs/en/context-window
7. https://code.claude.com/docs/en/best-practices
8. https://code.claude.com/docs/en/hooks
9. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
10. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
11. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
12. https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more
13. https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md (v2.1.266 head)
14. https://agents.md/ (first-party spec, not Anthropic)
15. Local: `~/.claude/plugins/cache/claude-plugins-official/skill-creator/0120fb83da5d/skills/skill-creator/SKILL.md`
    (Anthropic-shipped skill; two-field frontmatter, `references/`, `scripts/`, `agents/` subdirectories,
    a working example of the H21 progressive-disclosure layout)
