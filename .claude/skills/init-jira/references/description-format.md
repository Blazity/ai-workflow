# Description format — the Acceptance Criteria block

The agent reads `summary`, `description`, `comments`, and `attachments`. The description has one special section.

## Acceptance Criteria block

`extractAcceptanceCriteria` (`src/adapters/issue-tracker/jira.ts:202`) runs this regex on the description text:

```regex
/acceptance criteria[:\s]*([\s\S]*?)(?:\n\n|\n#|$)/i
```

Anything between the words "Acceptance Criteria" and the next blank line or `# heading` becomes the AC block in the agent prompt. Outside that block, description text is still available to the agent — but AC is what gets pulled into a structured field.

## Recommended description template

```markdown
## Context
Why this work matters, links to related tickets / Slack threads.

## Acceptance Criteria
- User can do X
- Endpoint returns 4xx when Y
- Existing test `foo.test.ts` still passes

## Notes
Implementation hints, files to look at, gotchas.
```

The agent will see the whole description; the AC list just gets a slot at the top of `requirements.md`.

## What the agent does NOT see

- **Custom fields** (Story Points, Epic Link, Sprint, etc.) — only `summary`, `description`, `comment`, `labels`, `status`, `project`, `attachment` are fetched. Put implementation-relevant info in the description.
- **Linked issues** — not followed. Inline relevant content.
- **Sub-tasks** — not fetched. Either inline or merge before sending.
- **Confluence pages** — not fetched. Paste relevant excerpts into the description.

## Attachments

Images, text files, and binaries are downloaded into the sandbox up to the env-configured limits (`ATTACHMENT_MAX_FILE_SIZE_MB`, `ATTACHMENT_MAX_TOTAL_SIZE_MB`, `ATTACHMENT_MAX_COUNT`, `ATTACHMENT_DOWNLOAD_TIMEOUT_MS`). Defaults: per-file 25 MB, total 100 MB, max 20 files, 30s timeout. Useful for handing the agent design mocks, error screenshots, or sample CSVs.
