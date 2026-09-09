# AIW-179 design QA

## Reference

- Approved Harness Profile Version Studio overview and edit direction.
- Approved right-side GitHub skill discovery drawer.
- Approved review-before-publish state.
- Viewport: 1487 × 1058.

## Verified states

- Profile catalog, search, archived filter, and system-profile read-only state.
- Organization-owned profile overview with draft status and immutable version history.
- Sectioned draft editor for runtime, context, instructions, skills, integrations, limits, and home files.
- GitHub skill Source, Discover, and Review states using `vercel-labs/skills`.
- Exact commit resolution, multi-select controls, skill metadata, and safety checks.
- Review-before-publish comparison and pinned-workflow warning.
- Archive confirmation and archived-profile recovery behavior.

## Visual comparison

- The implementation follows the approved Version Studio hierarchy while using the existing Cockpit typography, spacing, colors, controls, and navigation.
- The profile selector and filters remain in a compact top bar.
- Editing uses a persistent section rail and a focused content surface.
- Skill discovery uses a non-layout-shifting right drawer with the approved three-step progression.
- Publish review keeps the comparison as the primary surface and avoids editing controls.

## Result

No P0, P1, or P2 visual issues remain.

Final result: passed.
