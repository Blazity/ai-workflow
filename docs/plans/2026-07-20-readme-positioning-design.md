# README Positioning Design

## Goal

Replace the implementation-first README with a concise, value-first public product page for AI Workflow, then publish it with the promo video and comparison matrix.

## Positioning

AI Workflow is the free, open-source platform for building and operating visible, human-controlled engineering-agent workflows. The README describes the target product contract so it does not need a second structural rewrite while the remaining capabilities land. The repository is explicitly presented as actively built, and the roadmap is the single place that marks unfinished delivery as work in progress.

## Information Architecture

1. Product name, value proposition, open-source status, and active-development signal.
2. Promo video embedded from a GitHub user-attachment URL created through a pull-request comment.
3. The problem and the product's answer.
4. Differentiating value pillars: inspectability, human control, tool continuity, and organization-wide improvement.
5. A compact trigger-to-outcome workflow.
6. Use cases and target capabilities.
7. Public comparison matrix limited to the subset AI Workflow is designed to cover end to end.
8. Deployment architecture, setup, and repository map.
9. Work-in-progress roadmap.
10. License.

## Copy Rules

- Lead with the outcome, not repository mechanics.
- Use plain language and short sections.
- Describe the target state consistently across the hero, feature list, video, and comparison.
- Say that the project is actively being built and mark unfinished delivery in the roadmap.
- Avoid absolute security guarantees and unverifiable competitor claims.
- Date and qualify the public comparison as based on documented product capabilities.
- Keep detailed implementation material in existing linked documentation instead of reproducing it in the README.

## Video Publication

Follow the Atlas repository precedent:

1. Open the README pull request.
2. Upload `AI Workflow Promo.mp4` in a PR comment.
3. Keep the comment as the attachment host.
4. Copy the generated `https://github.com/user-attachments/assets/<id>` URL.
5. Embed that URL with an HTML `<video>` element in the README.

## Verification

- Render and inspect the Markdown structure.
- Verify every relative link resolves.
- Check formatting with `git diff --check`.
- Confirm the direct video asset loads from the README preview.
- Confirm the PR contains only intentional documentation changes.
