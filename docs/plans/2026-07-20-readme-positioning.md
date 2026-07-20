# README Positioning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish a value-first AI Workflow README with the promo video, public comparison matrix, concise technical onboarding, and a work-in-progress roadmap.

**Architecture:** Replace the current implementation-first README with one target-state product narrative. Keep setup and deep technical details behind existing documentation links, and host the promo video through a GitHub PR comment using the Atlas user-attachment pattern.

**Tech Stack:** GitHub-flavored Markdown, HTML video embed, Mermaid, Git, GitHub pull requests.

---

### Task 1: Rewrite the README

**Files:**
- Modify: `README.md`

**Step 1: Replace the opening narrative**

Add the value proposition, open-source/active-development signal, video placeholder, problem statement, and differentiating value pillars.

**Step 2: Add the product flow and capabilities**

Describe triggers, dynamic workflows, human clarification and approval, agent execution, pull-request delivery, observability, versioning, promotion, and team comparison as the target product contract.

**Step 3: Add the public comparison**

Use the approved seven-capability subset, legend, July 2026 review date, and links to official competitor product documentation.

**Step 4: Condense technical onboarding**

Keep architecture, deployment, repository layout, setup links, contribution commands, and license. Remove duplicated implementation deep dives already covered by `docs/`.

**Step 5: Add the roadmap**

Mark unfinished capabilities as work in progress: broader event adapters, governance/policy, prompt lifecycle, organization promotion, team/outcome analytics, and deployment portability.

### Task 2: Validate the documentation

**Files:**
- Test: `README.md`

**Step 1: Check local links**

Run a script that extracts relative Markdown targets and fails when a referenced file does not exist.

Expected: every relative target resolves.

**Step 2: Check formatting**

Run: `git diff --check`

Expected: no whitespace errors.

**Step 3: Review the rendered structure**

Inspect headings, tables, Mermaid syntax, and HTML video markup for GitHub compatibility.

Expected: concise top-level narrative; no duplicated deep-dive sections.

### Task 3: Publish the pull request and video

**Files:**
- Modify: `README.md`
- Source asset: `/Users/blazity/Downloads/AI Workflow Promo.mp4`

**Step 1: Commit the README**

Stage only the README and implementation plan, then commit with the repository's documentation commit style.

**Step 2: Push and open a draft pull request**

Push `codex/readme-positioning` to `origin` and open a draft PR against `main` with scope, rationale, and validation.

**Step 3: Upload the video**

Attach the MP4 in a PR comment and copy the generated `github.com/user-attachments/assets/<id>` URL.

**Step 4: Embed and verify the video**

Replace the README placeholder with the direct attachment URL, commit, push, and confirm the PR preview loads it.

**Step 5: Final PR review**

Inspect the complete diff, commit list, PR status, and checks. Confirm no unrelated files or local video binaries were added.
