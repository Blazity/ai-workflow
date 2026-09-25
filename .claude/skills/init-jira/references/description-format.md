# Description format: the Acceptance Criteria block

The agent reads `summary`, `description`, `comments` and `attachments`, plus one line each about the parent, subtasks and linked issues. The description has one special section.

## Acceptance Criteria block

`extractAcceptanceCriteria` (`integrations/jira/issue-tracker.ts`) looks for a label: "Acceptance criteria" anywhere, or "Acceptance" or "AC" alone at the start of a line followed by a colon or nothing (a heading, bullet or bold around it is fine). What follows the label, up to the next blank line or `#` heading, becomes the AC block in the agent prompt; a heading right after the label means the block is empty. The rest of the description still reaches the agent, but only the AC block gets its own field.

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

## What the agent does not see

- **Custom fields** (Story Points, Epic Link, Sprint, etc.): the fetched fields are `summary`, `description`, `comment`, `labels`, `status`, `project`, `attachment`, `parent`, `subtasks` and `issuelinks`. Put implementation-relevant info in the description.
- **What related tickets say.** The parent, subtasks and linked issues reach the prompt as one line each (key, relation, status, title), without their descriptions or comments. Inline what the agent needs.
- **Confluence pages**: not fetched. Paste relevant excerpts into the description.

## Attachments

Images, text files, and binaries are downloaded into the sandbox up to the attachment limits configured on the Settings page. Defaults are 25 MB per file, 100 MB total, 20 files, and a 30 second timeout. Useful for handing the agent design mocks, error screenshots, or sample CSVs.
