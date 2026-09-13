Status: current
Last-verified: 2026-09-13

# DESIGN.md: AI Workflow dashboard

> The written source of truth for the dashboard cockpit visual language.
> Read this before changing a cockpit screen or shared primitive. Facts are
> verified against the current dashboard. A rule marked `(proposed)` is the
> target for the shared primitive stage and is not yet guaranteed by code.

## 0. Scope

This file governs the AI Workflow dashboard cockpit:

| Surface | What it contains | Location |
| --- | --- | --- |
| Cockpit shell | Desktop rail, desktop top bar, mobile header, mobile tab bar | `apps/dashboard/app/(cockpit)` and `components/cockpit` |
| Operator screens | Overview, Runs, ticket, trace, approvals, cost, evals, memory, health, users | `apps/dashboard/components/cockpit/screens` |
| Authoring screens | Workflow editor, prompt library, harness profiles, repository catalog, settings | `apps/dashboard/components/cockpit` and `apps/dashboard/app/(cockpit)` |
| Existing shared UI | Logo, chip, dot, card, KPI, tabs, status pill, pagination, links | `apps/dashboard/components/ui.tsx` |
| Loading UI | Route skeletons and their block helper | `apps/dashboard/app/*-skeleton.tsx` and `skeleton-block.tsx` |

This file does not govern:

- The worker API, workflow execution, or stored workflow definition.
- Authentication pages outside `app/(cockpit)`.
- Emails, external provider pages, Jira, GitHub, GitLab, or Slack UI.
- Storefront, landing page, marketing page, or tenant branding conventions.
- Native application UI.

The cockpit is the only product surface in scope. Storefront-like sections
from the owner's shape and depth reference are intentionally omitted.

The existing code remains the runtime fact until the later primitive stage
migrates it. This document decides which current patterns survive that stage.

## 1. Visual theme and atmosphere

AI Workflow is a dense operator console. It should feel direct, technical,
calm, and inspectable. Information density is a feature. Visual noise is not.

### Current atmosphere

- Light mode only. There is no `.dark` token block or dark mode switch.
- The page canvas is cool light gray, `#f2f4f6`.
- Working surfaces are white, `#ffffff`, with neutral gray borders.
- Coal, `#181b20`, carries primary text and the strongest neutral actions.
- Mariner, `#3c43e7`, carries selection, focus, links, live work, and primary
  authoring actions.
- Burnt orange, `#fd6027`, identifies the Blazity mark and awaiting attention.
- Green, red, yellow, amber, and orange are operational semantics, not decor.
- Corners are compact, usually 2 px to 6 px. This is not a pill first product.
- Most surfaces are flat. Depth appears only for floating panels and live state.
- Uppercase JetBrains Mono labels create the console rhythm.
- Manrope gives headings and large metrics enough contrast from dense metadata.
- The LIVE and Watching indicator is state, not ornament. Motion must reflect
  the actual polling loop, as implemented in `controls.tsx`.
- Dark code and replay panels are local inspection surfaces, not dark mode.

### Motion inventory

The duration tokens are `--motion-fast` at 120 ms, `--motion-base` at 180 ms,
and `--motion-slow` at 240 ms. `--ease-standard` is
`cubic-bezier(0.2, 0, 0, 1)`, `--ease-emphasized` is
`cubic-bezier(0.3, 0, 0, 1)`, and `--ease-exit` is
`cubic-bezier(0.4, 0, 1, 1)`. Current animation tokens use these duration and
easing tokens for slides, pop, fade up, and chip entry. The pulse remains at
1.4 seconds and the shimmer remains at 1.6 seconds. March and glow are off.

Keyframe endpoints are current too: pulse scales 0.8 to 2.2 at opacity 1 to 0;
slides travel 100 percent to 0; pop moves from `translateY(-4px) scale(0.98)`;
shimmer travels negative 100 percent to 100 percent; march offsets stroke by
negative 16; `--ck-dash` supplies the drain endpoint; fade up starts at 6 px;
chip in scales 0.9 to 1.

### Motion doctrine

- Animate only opacity and transform. Never animate layout properties. Colour
  may transition at `--motion-fast`.
- Hover and press feedback on interactive primitives uses `--motion-fast`.
  Press scales to 0.98.
- Menus and inserted chips enter with the existing pop keyframes at
  `--motion-base`.
- A modal overlay fades at `--motion-base`. Its panel fades and scales from
  0.98 at `--motion-slow`. Exit uses `--motion-base` and `--ease-exit`.
- Skeleton shimmer and the LIVE pulse are the only continuous animations.
- Under `prefers-reduced-motion: reduce`, every motion duration token becomes
  0 ms and both continuous animations stop.
- Nothing animates on initial page load except the existing fade up, at most
  once per mount.

## 2. Colour palette and roles

### Rule zero for colour

Use a named role from `globals.css`. A raw hex, RGB value, or framework colour
at a component call site is a gap, even when it happens to match a token.
`globals.css` still contains a few literal colours for prompt rendering. Those
are current facts, not permission to repeat them.

### Brand and canvas tokens

| Token | Value | Canonical role |
| --- | --- | --- |
| `--color-burnt-orange` | `#fd6027` | Blazity mark and awaiting attention |
| `--color-mariner` | `#3c43e7` | Primary interaction, selection, focus, running |
| `--color-off-white` | `#f9fafb` | Quiet inset surface and code background |
| `--color-coal` | `#181b20` | Primary text and strongest neutral action |
| `--color-vibe-yellow` | `#ffc800` | Warning dot |
| `--color-sulu` | `#bbed80` | Green call to action accent, used sparingly |
| `--color-app-bg` | `#f2f4f6` | Application canvas and quiet row fill |
| `--color-panel` | `#ffffff` | Card, menu, modal, input, and table surface |

### Neutral scale and text ladder

| Token | Value | Canonical role |
| --- | --- | --- |
| `--color-neutral-100` | `#f9fafb` | Quiet table header and subtle hover |
| `--color-neutral-200` | `#e6e8eb` | Default border and skeleton base at 60 percent |
| `--color-neutral-300` | `#d2d6da` | Strong border, divider, disabled glyph |
| `--color-neutral-400` | `#b9bdc3` | Placeholder or disabled text |
| `--color-neutral-500` | `#9ea3aa` | Tertiary metadata and blocked dot |
| `--color-neutral-600` | `#7f858d` | Secondary metadata |
| `--color-neutral-700` | `#5f666f` | Secondary labels and control text |
| `--color-neutral-800` | `#3e444c` | Strong secondary text |
| `--color-neutral-900` | `#181b20` | Primary text, same value as coal |
| `--color-neutral-1000` | `#121418` | Deepest inspection surface |

Text roles are fixed:

| Text role | Token | Typical use |
| --- | --- | --- |
| Primary | coal or neutral 900 | Titles, values, table identity |
| Secondary | neutral 700 | Descriptions, inactive navigation, labels |
| Tertiary | neutral 500 | Timestamps, hints, empty state copy |
| Disabled | neutral 400 | Disabled value or unavailable metric |
| Interactive | mariner | Link, selected state, focus |
| Dangerous | fail foreground | Failure text and destructive intent |

Do not use neutral 300 or lighter for readable text on a white panel.

### Mariner scale

| Token | Value | Role |
| --- | --- | --- |
| `--color-mariner-100` | `#ececfd` | Selected row and running chip background |
| `--color-mariner-200` | `#d8d9fa` | Selected border and soft focus support |
| `--color-mariner-300` | `#c5c7f8` | Strong soft edge |
| `--color-mariner-400` | `#b1b4f5` | Disabled accent |
| `--color-mariner-500` | `#8a8ef1` | Prompt list marker |
| `--color-mariner-600` | `#6369ec` | Accent step |
| `--color-mariner-700` | `#3c43e7` | Same value as mariner, primary interaction |

### Yellow scale

| Token | Value |
| --- | --- |
| `--color-yellow-100` | `#fffae6` |
| `--color-yellow-200` | `#fff4cc` |
| `--color-yellow-300` | `#ffefb3` |
| `--color-yellow-400` | `#ffe999` |
| `--color-yellow-500` | `#ffde66` |
| `--color-yellow-600` | `#ffd333` |
| `--color-yellow-700` | `#ffc800` |

Yellow is warning only. The current warning foreground literal `#7a5a00` in
prompt and chip UI needs a semantic token before new use.

### Orange scale

| Token | Value |
| --- | --- |
| `--color-orange-100` | `#ffefe9` |
| `--color-orange-200` | `#ffdfd4` |
| `--color-orange-300` | `#fecfbe` |
| `--color-orange-400` | `#febfa9` |
| `--color-orange-500` | `#fea07d` |
| `--color-orange-600` | `#fd8052` |
| `--color-orange-700` | `#fd6027` |

Orange is awaiting input, activation attention, and the Blazity identity. It
must not become a second general interaction colour.

### Sulu scale

| Token | Value |
| --- | --- |
| `--color-sulu-100` | `#f2fbe6` |
| `--color-sulu-300` | `#d7f4b3` |
| `--color-sulu-500` | `#bbed80` |
| `--color-sulu-700` | `#8fc548` |

### Semantic status tokens

| Token | Value | Role |
| --- | --- | --- |
| `--color-success` | `#5bb04a` | Success dot and passed step |
| `--color-success-bg` | `#eaf7e0` | Success chip background |
| `--color-success-fg` | `#3f6b1e` | Success text |
| `--color-fail` | `#d14343` | Failed dot and error emphasis |
| `--color-fail-bg` | `#fce6e2` | Failed chip and error background |
| `--color-fail-fg` | `#a2351c` | Failed text |

### Run state mapping

| State | Background | Foreground | Dot or edge | Current source |
| --- | --- | --- | --- | --- |
| Success | success background, `#eaf7e0` | success foreground, `#3f6b1e` | success, `#5bb04a` | `components/ui.tsx:67,220` |
| Failed | fail background, `#fce6e2` | fail foreground, `#a2351c` | fail, `#d14343` | `components/ui.tsx:69,222` |
| Running | mariner 100, `#ececfd` | mariner, `#3c43e7` | mariner, `#3c43e7` | `components/ui.tsx:68,221` |
| Awaiting | orange 100, `#ffefe9` | fail foreground, `#a2351c` | burnt orange, `#fd6027` | `components/ui.tsx:72,224` |
| Cancelled | `#f6f7f8` | neutral 700, `#5f666f` | `#737981` | `workflow-replay.tsx:84-87` |
| Blocked | app background, `#f2f4f6` | neutral 700, `#5f666f` | neutral 500, `#9ea3aa` | `components/ui.tsx:71,223` |

Cancelled uses replay literals today. Semantic cancelled background and dot
tokens are required before the mapping becomes shared `(proposed)`.

Running and awaiting dots may pulse. Success, failed, cancelled, and blocked
are static. A pulse reports active work, never severity.

### Literal colours still in `globals.css`

These values are present outside the theme token block and must be treated as
migration inventory:

| Value | Current use |
| --- | --- |
| `#f2f4f6`, `#181b20` | Body canvas and text |
| `rgba(0, 0, 0, 0.18)` | Scrollbar thumb |
| `rgba(60, 67, 231, 0.22)` | Low live glow |
| `rgba(60, 67, 231, 0.25)` | Low live ring |
| `rgba(60, 67, 231, 0.45)` | High live glow |
| `rgba(60, 67, 231, 0.5)` | High live ring |
| `#34383f` | Markdown preview body |
| `#8a8ef1` | Prose list marker |
| `#7a5a00` | Unknown variable foreground |
| `#e8f1ff` | Prompt reference background |
| `#1f5aa6` | Prompt reference foreground |
| `#bfd4f2` | Prompt reference inset edge |

## 3. Typography

### Font stack

| Token | Stack | Loaded weights and source | Role |
| --- | --- | --- | --- |
| `--font-display` | Manrope, system UI, sans serif | Local variable font, 200 through 800 | Headings, KPI values, prominent names |
| `--font-body` | Inter, system UI, sans serif | Local italic 100 through 900, Google normal 400 through 700 | Sentences, form labels, table identity |
| `--font-sans` | Inter, system UI, sans serif | Same Inter sources | Alias, do not prefer over body |
| `--font-mono` | JetBrains Mono, UI monospace, monospace | Local variable font, 100 through 800 | IDs, time, status, metadata, compact actions |
| `--font-wordmark` | Rethink Sans, system UI, sans serif | Google 500 through 800 | Blazity wordmark only |

The local Inter file is italic only. Normal Inter currently depends on the
Google stylesheet in `app/layout.tsx:25-27`.

### Weight doctrine

| Role | Weight |
| --- | --- |
| Page and section title | 600 |
| Card title and prominent label | 500 or 600 |
| Body copy | 400 |
| Control label | 500 or 600 |
| Mono metadata | 400 or 500 |
| Strong KPI value | 600 |

Do not use weight alone to express state. Pair it with colour, border, copy,
or a semantic marker.

### Type size inventory

The cockpit currently uses these explicit sizes:

`8px`, `9px`, `10px`, `11px`, `11.5px`, `12px`, `13px`, `14px`, `15px`,
`16px`, `17px`, `18px`, `20px`, `22px`, `24px`, `25px`, `26px`, `28px`,
`32px`, and `36px`.

Tailwind aliases in use add `text-xs` at 12 px, `text-sm` at 14 px,
`text-base` at 16 px, `text-lg` at 18 px, `text-xl` at 20 px, and `text-2xl`
at 24 px. Values that resolve to the same size are one visual size.

### Canonical type ladder

| Role | Family | Size | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Page title | display | 24 px | 600 | `-0.02em` |
| Section title | display | 20 px | 600 | `-0.01em` |
| Card title | display | 16 px | 500 | normal |
| KPI value | display | 32 px | 600 | `-0.02em` |
| Body | body | 13 px | 400 | normal |
| Compact body | body | 12 px | 400 or 500 | normal |
| Control | mono | 11 px | 500 or 600 | `0.04em` only when uppercase |
| Table header | mono | 10 px | 500 | `0.06em` |
| Chip | mono | 10 px | 500 | `0.02em` to `0.04em` |
| Micro label | mono | 9 px | 500 | `0.04em` to `0.06em` |

Every value in this ladder is already present in the cockpit. Do not add a
nearby arbitrary size when one of these roles fits.

### Tracking

- Display headings use normal or negative tracking.
- Body copy uses normal tracking.
- Uppercase mono labels use `0.04em` or `0.06em`.
- Chips may use `0.02em`.
- `0.05em`, `0.07em`, `0.08em`, and `0.09em` are current drift and should
  converge on `0.04em` or `0.06em`.
- Never add positive tracking to mixed case body copy.

### Numbers and monospace

- Use JetBrains Mono for run IDs, ticket keys, repository refs, timestamps,
  durations, token counts, costs in rows, versions, and command text.
- Use Manrope for large summary numbers, as `CkKPI` does.
- Right align comparable numeric table columns.
- Preserve the formatter and unit used by the owning domain.
- Use tabular figures only when alignment requires them `(proposed)`. The
  current cockpit has one `tabular-nums` call site in prompt reference metadata.
- Do not use monospace for prose, explanations, modal body copy, or errors.

### Prompt content exception

The prompt editor and markdown preview have their own reading scale in
`globals.css`:

| Surface | Body | H1 | H2 | H3 | Code |
| --- | --- | --- | --- | --- | --- |
| Editable prose | 13 px, line height 1.65 | 19 px | 16 px | 14 px | 11.5 px, line height 1.6 in blocks |
| Read only preview | 12.5 px, line height 1.62 | 17 px | 14.5 px | 13 px | Inherited content recipe |

These sizes are content rendering, not general cockpit UI sizes.

### Spacing values local to `globals.css`

The base margin and padding reset is 0. The scrollbar is 8 px in each axis.
Editable prose uses 0.9 em sibling rhythm, 0.5 em heading bottom space, 1.25 em
H1 and H2 top space, 0.9 em H3 top space, 1.5 em list inset, 0.35 em list gap,
and 0.15 em list item inset. Inline code padding is 0.1 em by 0.36 em. Code
block padding is 10 px by 12 px. Markdown preview rhythm is 0.72 em between
children, 1.35 em before headings, and 0.42 em after headings. Variable token
padding is 0.02 em by 0.22 em. These values stay local to rendered content.

## 4. Component system

### Rule zero: the shared component IS the design system

The shared primitive owns appearance and interactive state. A screen chooses a
component, variant, and size. It does not recreate that component from a list
of utility classes.

Resolution order:

1. Use the dashboard primitive exported from `apps/dashboard/components/ui`.
2. If it is missing, add it there in the later primitive stage.
3. Keep headless behavior and visual skin together.
4. A domain wrapper may add copy or data mapping, but not a new skin.
5. A raw native control is allowed only inside the shared primitive.

The existing `ui.tsx` exports chips, dots, cards, KPIs, tabs, status,
pagination, and links. The `components/ui/` directory exports Button,
IconButton, Input, Textarea, Field, Select, Modal, and Skeleton. It also
reexports `CkChip` and `CkDot`. Table and Toast still need canonical exports
`(proposed)`.

### Buttons

Canonical variants:

| Variant | Job | Current visual source |
| --- | --- | --- |
| Primary | Confirm a main action | Mariner fill in repository and editor actions |
| Secondary | Alternative or cancel | White panel, neutral 300 border |
| Ghost | Low emphasis action in a dense row | Transparent background, no border |
| Danger | Delete, revoke, cancel irreversible state | Red intent, never mariner |
| Icon | One glyph with accessible label | 26 px or 30 px square controls |

Sizes:

| Size | Height | Horizontal padding | Text |
| --- | --- | --- | --- |
| Compact | 26 px | 8 px | 9 px or 10 px mono |
| Default | 30 px | 12 px | 10 px or 11 px mono |
| Icon compact | 26 px | 0 | Icon only |
| Icon default | 30 px | 0 | Icon only |

States: default supplies fill, edge, foreground, and 3 px radius;
hover changes colour or border; focus uses a visible 2 px mariner ring;
disabled keeps readable copy at 40 percent opacity; loading preserves width.

Implemented by `components/ui/button.tsx` and
`components/ui/icon-button.tsx`.

Consumers: every screen, especially Repositories, Settings, Runs, Workflow
editor, Prompt library, Harness profiles, Health, Users, and modal footers.

### Select and combobox

The canonical Select is the current `Listbox` behavior with two densities.
Use native `select` only inside the primitive or when a platform
constraint is documented.

| Size | Height | Use |
| --- | --- | --- |
| Compact | 26 px | Node configuration and dense editor rows |
| Default | 30 px | Settings, repository forms, filters |

Options use a 34 px row estimate today. The menu caps at 360 px and opens 6 px
from its trigger. Its current panel is white, 4 px radius, neutral 200 edge,
and elevation level 3.

Arrow keys move through enabled options. Home and End move to the first and
last enabled options. Escape closes the menu. Disabled options remain visible
and cannot be selected. Type ahead is not part of the current Listbox behavior.

States: default uses a white or off white surface, neutral 200
edge, and coal value; hover uses neutral 300; focus adds mariner edge and ring;
disabled uses 60 percent opacity; error adds a fail edge and linked message
without recolouring the value.

Implemented by `components/ui/select.tsx`.

Consumers: Settings, Repository detail, Workflow editor block fields, prompt
slots, schedule fields, and harness profile selection.

### Form controls

Canonical single line control heights are 26 px compact and 30 px default.
The default matches the explicit profile input and the common 12 px text with
6 px vertical padding.
Checkboxes, radios, multiline textareas, search, and code editors are shape
exceptions, not alternate text input heights.

Canonical variants:

| Variant | Geometry | Use |
| --- | --- | --- |
| Input | 26 px or 30 px high | One line text, number, URL, or identifier |
| Textarea | 72 px or 88 px minimum height | Prose or multiline configuration |
| Checkbox | 12 px square | One independent or grouped binary choice |
| Switch | 32 px by 18 px track, 14 px thumb | A setting that takes effect when toggled |

Search and Radio remain proposed variants `(proposed)`.

Field owns the visible label, optional hint, persistent error, required marker,
and the IDs that connect that copy to its control through `aria-describedby`.

Default input recipe: 30 px height, 3 px radius, white panel, neutral 200
border, 8 px horizontal padding, 11 px or 12 px text. Every listed value is in
current profile, setting, repository, or editor controls.

States: default uses neutral 200 edge, coal value, and neutral 400
placeholder; hover uses neutral 300; focus adds mariner edge and 2 px ring;
disabled uses app background and 60 percent opacity; error adds a fail edge and
persistent linked text. Textarea is a height exception with compact and default
minimum heights of 72 px and 88 px.

Implemented by `components/ui/input.tsx`, `components/ui/textarea.tsx`,
`components/ui/field.tsx`, `components/ui/checkbox.tsx`, and
`components/ui/switch.tsx`.

Consumers: Settings, Repository catalog, Repository detail, Workflow editor,
Prompt library, Harness profiles, Trace clarification, Users, and dispatch.

### Tabs

Canonical variants:

| Variant | Job | Current source |
| --- | --- | --- |
| Segmented | Filter or swap content in one panel | `CkTabs`, `WindowSelector` |
| Route | Change a linkable repository subsection | `RouteTabs` |

Segmented tabs use a 3 px outer inset, 4 px outer radius, 3 px item radius,
11 px uppercase mono text, and 180 ms standard easing. The active item is a
white panel with the level 2 shadow. Route tabs use the same text role but a
mariner bottom edge.

States: default is neutral 700 on transparent; hover uses neutral
900 or app background; focus uses a 2 px mariner ring; disabled uses 40 percent
opacity; loading keeps the active tab stable; error keeps geometry and marks
the tab while the panel explains the failure.

Route tabs are implemented by `components/ui/route-tabs.tsx`. Segmented tab
canonicalization remains proposed pending one primitive shared by its consumers.

Consumers: Runs filters, global window selection, Repository detail, Workflow
editor panels, Prompt library filters, and Harness profiles.

### Modal and drawer

Canonical desktop modal sizes:

| Variant | Width or placement | Current source |
| --- | --- | --- |
| Small modal | 476 px max | Manual dispatch and webhook test |
| Medium modal | 680 px max | Data picker and repository scope |
| Large modal | 1240 px max | Prompt editor |

Side drawer and Mobile sheet are implemented variants.

Desktop modal panels use a 6 px radius and level 4 shadow. Mobile sheets use a
16 px top radius and the existing upward drawer shadow. Every dialog caps its
height against the viewport and scrolls its body, not its title or footer.

States: default moves focus inside and prevents background interaction; hover
belongs to contained controls; focus is trapped and visible; Escape and overlay
click close the modal; error stays inside the body or above the footer.

Implemented by `components/ui/modal.tsx`.

Consumers: manual dispatch, repository activation and import, repository
scope, workflow data picker, prompt editor, skill import, user management,
activity, and mobile More navigation.

### Data tables and lists

Canonical variants `(proposed)`:

| Variant | Job |
| --- | --- |
| Data table | Comparable columns and numeric scan |
| Selection list | One primary identity with metadata and row action |
| Definition list | Key and value inspection without row actions |
| Mobile card list | Responsive substitute when columns cannot remain useful |

The canonical table uses 13 px body text, 10 px uppercase mono headers,
neutral 100 header fill, neutral 200 row edges, 12 px horizontal cell padding,
and 10 px vertical cell padding. Numeric cells align right. Identity aligns
left. The table is wrapped in a 4 px card or responsive overflow container.

States `(proposed)`: default is flat white with neutral edges; actionable hover
uses neutral 100; focus follows the row action; disabled mutes the action, not
the data; loading uses shape matched rows; error spans columns or supplies a
retry surface.

Consumers: Overview recent runs and workflows, Runs, Cost, Users, run analysis,
repository history, schedule history, and webhook history.

### Status chips and dots

Canonical chip variants are neutral, success, running, failed, warning,
blocked, awaiting, cancelled, mariner, orange, and coal. This extends current
`CkChip` with cancelled `(proposed)`.

Chips use 2 px radius, 8 px horizontal padding, 3 px vertical padding, 10 px
uppercase mono text, medium weight, and `0.02em` tracking. A dot is 6 px by
default. Use the run state mapping in section 2.

States `(proposed)`: default uses semantic background and foreground with an
optional dot; hover is absent unless interactive; focus follows Button;
disabled becomes neutral; loading uses running only for actual work; error uses
failed, never warning.

Consumers: every run surface, Health, Settings source labels, repository state,
prompt state, harness profiles, schedule history, and user invitations.

### Cards

`CkCard` is the canonical card. It uses a white panel, neutral 200 border,
4 px radius, and no shadow. Its default padding is 20 px. Header spacing uses
20 px horizontal, 18 px top, and 14 px bottom. The eyebrow is a 10 px uppercase
mono label. The title is 16 px Manrope medium.

Canonical variants `(proposed)`:

| Variant | Job |
| --- | --- |
| Standard | Group related content |
| Flush | Table or list owns the card body edges |
| KPI | One metric and supporting trend |
| Inset | Quiet app background inside a larger card |
| Dark inspection | Replay or code evidence only |

States `(proposed)`: default is flat with a neutral edge; hover is absent unless
actionable; focus uses a mariner ring; disabled affects actions, not readable
content; loading matches final dimensions; error is contained, not a red card.

Consumers: all operator summaries, Overview, Cost, Evals, Memory, Prompt
library, Settings, Health, repository panels, and editor inspectors.

### Toasts

There is no shared toast or mounted toaster today. Success and error feedback
is currently embedded per row or per form.

Canonical variants are success, information, warning, and error `(proposed)`.
Desktop placement is bottom right `(proposed)`. Mobile placement is above the
bottom tab bar `(proposed)`. Width, timeout, queue size, and animation values
must be chosen during implementation and recorded here `(proposed)`.

States `(proposed)`: default has a semantic icon, concise title, and optional
detail; hover pauses timed dismissal; focus reaches actions and dismiss;
disabled follows Button; loading is persistent information; error persists
when recovery requires action.

Use a toast for cross screen confirmation or background completion. Keep
validation errors beside their field and row specific outcomes in their row.

Consumers: repository import and activation, settings save, run cancellation,
prompt save, profile save or import, workflow deploy, and user invitations.

### Skeletons

The canonical visual recipe is neutral 200 at 60 percent, 4 px radius, and the
existing shimmer animation. Shapes match the final layout.

Canonical variants:

| Variant | Job |
| --- | --- |
| Line | One text line shape |
| Block | Generic shape matched placeholder |
| Circle | Avatar or round control placeholder |

States: default is a neutral shimmer; hover and disabled do not
apply; focus is impossible; loading respects reduced motion and final geometry;
error replaces the skeleton with error or retry UI.

Implemented by `components/ui/skeleton.tsx`.

Consumers: Overview, Runs, ticket, Trace, Approvals, Cost, Evals, Memory,
Prompts, Harness profiles, Health, Users, Repositories, and Settings.

### Icons

The current cockpit mixes Unicode glyphs, inline SVG, text symbols, and
Phosphor icons. Use Phosphor for general interface icons `(proposed)`. Keep a
custom SVG only for the Blazity logo, charts, graph edges, and geometry that is
not an interface glyph. Default icon size is 16 px `(proposed)`. Default stroke
weight follows the chosen Phosphor icon's regular weight `(proposed)`.

States `(proposed)`: default inherits text colour; hover inherits the parent;
focus belongs to the parent control; disabled inherits parent opacity; loading
uses the shared progress icon; error uses fail only with error semantics.

Consumers: navigation, buttons, select triggers, table actions, status,
empty states, modals, prompt editor, repository editor, and workflow graph.

### Filters and toolbars

Canonical toolbar variants `(proposed)`:

| Variant | Contents |
| --- | --- |
| Screen toolbar | Title companion, filters, primary action |
| Table toolbar | Search, status filter, time window, result count |
| Editor toolbar | Scope, validation, view controls, deploy action |

Toolbars wrap at narrow widths. They use the 16 px and 24 px screen gutter,
8 px control gaps, and shared Button, Select, Input, and Tabs. Filter state
that changes the server result belongs in the URL, as `WindowSelector` does.

States `(proposed)`: default controls align at 30 px; hover belongs to each
primitive; focus order matches visual order; disabled explains unavailable
primary actions; loading keeps independent filters usable; error preserves
values and offers retry.

Consumers: Overview, Runs, Cost, Health, Users, Repositories, Prompt library,
Harness profiles, Workflow editor, and Trace.

## 5. Layout principles

### Cockpit frame

- The root frame is `100dvh` and viewport width, with overflow contained.
- Desktop chrome begins at the `lg` breakpoint.
- The desktop sidebar is 220 px open and 60 px collapsed.
- The desktop top bar is 44 px high.
- The mobile header is 48 px high.
- Mobile uses a bottom tab bar with the safe area inset.
- Content owns its scrolling inside the shell.
- Split grid tracks use `minmax(0, 1fr)` and children use `min-w-0`.

### Horizontal gutter

One cockpit gutter rule `(proposed)`:

```text
default: 16 px
lg and above: 24 px
```

This selects the pattern already used by Memory, Cost, Evals, Prompt library,
Harness profiles, Health, Users, Repositories, and Settings. Overview, Runs,
Approvals, and Trace currently use 24 px at every width and must converge.

### Spacing scale

The cockpit uses Tailwind's 4 px base plus half steps. Canonical spacing values
already present in screens are:

| Value | Typical utility | Use |
| --- | --- | --- |
| 2 px | `gap-0.5` | Segmented controls only |
| 4 px | `gap-1` | Tight metadata |
| 6 px | `gap-1.5` | Chip and icon gaps |
| 8 px | `gap-2` | Control and compact row gaps |
| 12 px | `gap-3` | Card grids and row groups |
| 16 px | `gap-4` | Screen section rhythm |
| 20 px | `gap-5` | Overview major rhythm |
| 24 px | `gap-6`, `p-6` | Desktop gutter and roomy panel padding |
| 32 px | `gap-8` | Hero composition only |

Do not add an arbitrary spacing value when this scale can express the job.
Existing 3 px, 5 px, 7 px, 9 px, 10 px, 14 px, and 18 px values belong only
to established compact component geometry, not general page layout.

### Radius scale

The inventory found nine distinct radius values or shapes in cockpit TSX:
1 px, 2 px, 3 px, 4 px, 5 px, 6 px, 16 px, 999 px, and full circle.

Canonical scale `(proposed)`:

| Value | Use |
| --- | --- |
| 1 px | Progress tracks and tiny graph marks only |
| 2 px | Chips, code tokens, micro status |
| 3 px | Buttons, inputs, tab items, row alerts |
| 4 px | Cards, menus, popovers, table containers |
| 6 px | Desktop modals |
| 16 px top corners | Mobile sheets only |
| 999 px | Intentional pills through `--radius-pill` |
| Full circle | Dots, avatars, round icon actions |

The current 5 px modal and card radius is drift. New use is forbidden.

### Breakpoints

`globals.css` does not override Tailwind breakpoints. The current breakpoints
are therefore:

| Name | Minimum width | Cockpit use |
| --- | --- | --- |
| Default | 0 | Single column, mobile chrome |
| Phone QA | 390 px viewport | Required repository list and entry check |
| `sm` | 640 px | Row alignment and minor grid changes |
| `md` | 768 px | Wider grids and table layouts |
| `lg` | 1024 px | Desktop sidebar and top bar, 24 px gutter |
| `xl` | 1280 px | Wide editor and profile split panels |
| `2xl` | 1536 px | Tailwind default, no cockpit specific rule |

At 390 px:

- No non responsive fixed width may exceed the available content width.
- Tabs wrap or become a deliberate scroll region.
- Dialogs cap at `calc(100dvh - 32px)`.
- Primary actions stay in the tree and remain reachable.
- Wide data tables use a mobile list or an explicit inner scroll container.
- The page itself does not scroll horizontally.

## 6. Depth and elevation

Depth communicates stacking, not importance. Standard cards stay flat.

### Canonical ladder

| Level | Recipe | Use | Current source |
| --- | --- | --- | --- |
| 0, flat | No shadow | Page, card, table row | `CkCard` |
| 1, edge | Neutral 200 border | Cards and controls | `CkCard`, inputs |
| 2, selected | `0 1px 2px rgba(24,27,32,0.06)` | Active segmented tab | `CkTabs` |
| 3, popover | `0 12px 28px -8px rgba(24,27,32,0.22), 0 2px 6px rgba(24,27,32,0.08)` | Select, editor popover | `Listbox` |
| 4, modal | `0 24px 64px -16px rgba(24,27,32,0.45)` | Modal and command overlay | Spotlight, prompt editor |
| 5, side drawer | `-12px 0 32px rgba(24,27,32,0.08)` | Right activity drawer | `activity-drawer.tsx` |
| 5, bottom sheet | `0 -6px 24px rgba(24,27,32,0.12)` | Mobile sheet | `mobile-sheet.tsx` |

### Live elevation exception

The running node glow is defined in `globals.css`:

- Low frame: 2 px ring at mariner 25 percent and 10 px glow at 22 percent.
- High frame: 3 px ring at mariner 50 percent and 22 px glow at 45 percent.
- Duration: 1.7 seconds, infinite ease in and out.
- Prompt references use `inset 0 0 0 1px #bfd4f2`, a content marker rather than elevation.

Use it only on the active workflow node. Do not apply it to buttons, cards,
status chips, or passive running labels.

### Elevation rules

- A border is level 1, not decorative depth.
- A card does not gain shadow because it contains important content.
- A popover uses level 3.
- A centered modal uses level 4.
- A drawer uses the directional level 5 recipe for its edge.
- Nested surfaces do not stack shadows.
- Focus rings are interaction state, not elevation.
- The 28 distinct shadow utility recipes in current cockpit source are debt.
  New recipes require this ladder to change first.

## 7. Do's and don'ts

Each rule below is grounded in a current violation and points to its first clear
example. The appendix carries the screen ordered inventory.

### Do

1. Do use one shared Button variant. Repository actions repeat at `repositories-screen.tsx:196` and `suggestion-panel.tsx:195`.
2. Do use the shared Select. Seventeen native selects remain, starting at `repository-entry.tsx:705`.
3. Do use the 30 px default input. Users uses 38 px at `users.tsx:515`.
4. Do keep compact 26 px controls inside dense editor rows. `Listbox` establishes this exception at `listbox.tsx:137`.
5. Do use shared segmented Tabs. `CkTabs` and `WindowSelector` duplicate the skin at `ui.tsx:198` and `controls.tsx:45`.
6. Do use one modal shell. Dispatch and webhook test copy a 476 px panel at `manual-dispatch-modal.tsx:128` and `webhook-test-delivery-modal.tsx:157`.
7. Do use neutral 100 table headers. Overview uses off white at `overview.tsx:552`.
8. Do route operational status through the status mapping. Replay hardcodes another palette at `workflow-replay.tsx:42`.
9. Do keep cards flat with a neutral edge. Prompt body cards add a local shadow at `prompt-body-blocks.tsx:39`.
10. Do use the shared Skeleton block. Five skeleton files define private copies, including `overview-skeleton.tsx:2`.
11. Do keep field errors beside their field. Repository detail does this at `repository-entry.tsx:574`.
12. Do preserve filter state in the URL. Runs holds its status filter locally at `runs.tsx:127`.
13. Do keep page gutters responsive. Runs pins 24 px on phones at `runs.tsx:111`.
14. Do use one icon family. Dispatch uses Phosphor at `manual-dispatch-modal.tsx:5`, while navigation uses glyphs at `chrome.tsx:6`.
15. Do use semantic colour tokens. The active nav repeats `#ececfd` at `chrome.tsx:117`.

### Don't

1. Do not add another raw button class expression. The inventory finds 228 across 323 native buttons.
2. Do not add an input height. Eight explicit values remain, plus padding only inputs.
3. Do not use raw framework status colours. Health does this at `health.tsx:190` and `health.tsx:198`.
4. Do not use fail foreground for awaiting. `CkChip` does this at `ui.tsx:72`.
5. Do not let an unknown status fall back to success. `CkStatusPill` does so at `ui.tsx:227`.
6. Do not use a 5 px corner. Prompt reference cards use it at `prompt-reference-chips.tsx:168`.
7. Do not invent a modal shadow. User management does at `users.tsx:688`.
8. Do not rebuild table headers. Runs uses 12 px at `runs.tsx:147`, Cost uses 16 px at `cost.tsx:89`.
9. Do not cover a clickable card with an invisible button. Mobile Overview does at `overview-mobile.tsx:107`.
10. Do not use text glyphs for primary navigation icons. `chrome.tsx:6-18` is the current gap.
11. Do not load interface fonts from competing sources. `globals.css:19` and `layout.tsx:25` split Inter.
12. Do not leave global success in a local row. Cancellation feedback is duplicated at `runs.tsx:82` and `runs-mobile.tsx:83`.
13. Do not use a toast for validation. Settings keeps field errors in form at `settings-group-form.tsx:320`.
14. Do not leave a skeleton active after an error. Replace it with error or retry UI.
15. Do not apply replay colours to the whole app. `workflow-replay.tsx:635` is a local evidence panel.

## 8. Appendix: gap inventory

### Inventory counts and method

The inventory covers non test TSX under `app/(cockpit)`, non test TSX under
`components/cockpit`, and `components/ui.tsx`.

| Measure | Count | Definition |
| --- | ---: | --- |
| Native button instances | 323 | JSX `button` elements |
| Distinct button styles | 228 | Unique `className` expressions on native buttons |
| Native input instances | 103 | JSX `input` elements |
| Distinct explicit input heights | 8 | 12, 26, 30, 32, 34, 36, 38, and 40 px |
| Distinct input height class patterns | 10 | Nine explicit utility spellings plus padding only |
| Native select instances | 17 | JSX `select` elements |
| Native textarea instances | 18 | JSX `textarea` elements |
| Native table instances | 7 | JSX `table` elements |
| Distinct radius values or shapes | 9 | 1, 2, 3, 4, 5, 6, 16, 999 px, and full circle |
| Distinct shadow utility recipes | 28 | Arbitrary shadows plus `shadow-sm` and `shadow-2xl` |

Input height patterns found on native input tags:

| Pattern | Current use |
| --- | --- |
| Padding only | 74 instances, height derives from font, line height, padding, border |
| 12 px | 18 checkboxes and radios via `h-3` |
| 26 px | Workflow name input |
| 32 px | Loop and profile controls |
| 40 px | Repository scope and dispatch controls |
| 36 px | Harness skill import |
| 34 px | Harness skill search |
| 30 px | Harness profile text controls |
| 38 px | User management input |
| 32 px explicit | Harness profile filter, separate expression from `h-8` |

### Screen ordered gaps

| Screen | Control | File and line | What it does today | Violates |
| --- | --- | --- | --- | --- |
| Shared shell | Navigation icons | `components/cockpit/chrome.tsx:6` | closed in D3-C | 4, Icons |
| Shared shell | Active navigation | `components/cockpit/chrome.tsx:117` | closed in D3-C | 2, colour rule zero |
| Shared shell | Sidebar buttons | `components/cockpit/chrome.tsx:108` | closed in D3-C | 4, Buttons |
| Shared shell | Live control | `components/cockpit/controls.tsx:137` | closed in D3-C | 4, Buttons and Status |
| Shared shell | Window tabs | `components/cockpit/controls.tsx:45` | closed in D3-C | 4, Tabs |
| Shared shell | Activity drawer | `components/cockpit/activity-drawer.tsx:65` | closed in D3-C | 4, Modal and drawer |
| Shared shell | Spotlight | `components/cockpit/spotlight-search.tsx:235` | closed in D3-C | 4 and 6, Modal |
| Overview | Page gutter | `components/cockpit/screens/overview.tsx:420` | closed in D3-C | 5, gutter |
| Overview | Recent runs header | `components/cockpit/screens/overview.tsx:552` | closed in D3-C | 4, Data tables |
| Overview | Workflow table | `components/cockpit/screens/overview.tsx:659` | Repeats table skin | 4, Data tables |
| Overview | Workflow chip | `components/cockpit/screens/overview.tsx:599` | closed in D3-C | 2, colour rule zero |
| Runs | Page gutter | `components/cockpit/screens/runs.tsx:111` | closed in D3-C | 5, gutter |
| Runs | Status filter | `components/cockpit/screens/runs.tsx:127` | Uses local state, not URL state | 4, Filters and toolbars |
| Runs | Runs table | `components/cockpit/screens/runs.tsx:143` | Hand built table | 4, Data tables |
| Runs | Cancel feedback | `components/cockpit/screens/runs.tsx:82` | Local row feedback duplicated on mobile | 4, Toasts |
| Ticket and Trace | Run selection | `components/cockpit/screens/ticket.tsx:125` | closed in D3-C | 4, Data tables and lists |
| Ticket and Trace | Trace actions | `components/cockpit/screens/trace.tsx:410` | Local outline button skin | 4, Buttons |
| Ticket and Trace | Clarification textarea | `components/cockpit/screens/trace.tsx:828` | Own focus recipe and padding | 4, Form controls |
| Ticket and Trace | Awaiting panel | `components/cockpit/screens/trace.tsx:740` | Hardcodes background and edge | 2, colour rule zero |
| Approvals | Approval row | `components/cockpit/screens/approvals.tsx:128` | closed in D3-C | 4, Data tables and lists |
| Approvals | Action buttons | `components/cockpit/screens/approvals.tsx:270` | closed in D3-C | 4, Buttons |
| Cost | Cost table | `components/cockpit/screens/cost.tsx:85` | Uses 16 px cell padding | 4, Data tables |
| Evals | Empty card | `components/cockpit/screens/evals.tsx:27` | Rebuilds a card instead of `CkCard` | 4, Cards |
| Prompt library | Primary action | `components/cockpit/screens/prompt-library.tsx:38` | Private mariner button constant | 4, Buttons |
| Prompt library | Filter select | `components/cockpit/flow-editor/prompt-library-rail.tsx:325` | Native select | 4, Select |
| Prompt library | Prompt body card | `components/cockpit/prompt-library/prompt-body-blocks.tsx:39` | Uses local shadow | 6, elevation |
| Prompt library | Reference card | `components/cockpit/prompt-editor/prompt-reference-chips.tsx:168` | Uses 5 px radius | 5, radius |
| Memory | Action buttons | `components/cockpit/screens/memory.tsx:289` | Private secondary button helper | 4, Buttons |
| Workflow editor | Deploy button | `components/cockpit/screens/workflow-editor.tsx:1261` | Uses emerald instead of canonical primary | 2 and 4, colour and Buttons |
| Workflow editor | Native selects | `components/cockpit/flow-editor/blocks/transform.tsx:161` | Repeats native select for transform fields | 4, Select |
| Workflow editor | Node controls | `components/cockpit/flow-editor/flow-editor.tsx:1274` | Own 26 px icon button | 4, Buttons |
| Workflow editor | Prompt modal | `components/cockpit/flow-editor/prompt-editor-modal.tsx:278` | Own large modal shell | 4, Modal |
| Workflow editor | Scope modal | `components/cockpit/flow-editor/repository-scope-modal.tsx:300` | Uses `shadow-2xl` and 6 px radius | 6, elevation |
| Workflow editor | Status palette | `components/cockpit/screens/workflow-replay.tsx:42` | Hardcodes replay status colours | 2, status roles |
| Workflow editor | Cancelled state | `components/cockpit/screens/workflow-replay.tsx:84` | Uses unowned cancelled literals | 2, status tokens |
| Harness profiles | Text input | `components/cockpit/harness-profiles/profile-editor.tsx:35` | Establishes 30 px but remains private | 4, Form controls |
| Harness profiles | Buttons | `components/cockpit/harness-profiles/profile-editor.tsx:39` | Private primary and secondary constants | 4, Buttons |
| Harness profiles | Profile cards | `components/cockpit/harness-profiles/profile-editor.tsx:740` | Repeats 4 px panel recipe | 4, Cards |
| Harness profiles | Skill drawer | `components/cockpit/harness-profiles/skill-import.tsx:410` | Uses `shadow-2xl` | 4 and 6, Drawer |
| Repositories | Header actions | `app/(cockpit)/repositories/repositories-screen.tsx:196` | closed in D3-D | 4, Buttons |
| Repositories | Empty action | `app/(cockpit)/repositories/repositories-screen.tsx:269` | closed in D3-D | 4, Buttons |
| Repositories | Activation dialog | `app/(cockpit)/repositories/activate-dialog.tsx:160` | closed in D3-D | 4, Modal |
| Repositories | Import dialog | `app/(cockpit)/repositories/import-dialog.tsx:135` | closed in D3-D | 4, Modal |
| Repositories | Detail tabs | `app/(cockpit)/repositories/repository-entry.tsx:394` | closed in D3-D | 4, Tabs |
| Repositories | History select | `app/(cockpit)/repositories/repository-entry.tsx:705` | closed in D3-D | 4, Select |
| Repositories | Suggest action | `app/(cockpit)/repositories/suggestion-panel.tsx:195` | closed in D3-D | 4, Buttons |
| Repositories | Script inputs | `components/cockpit/screens/repositories/script-groups.tsx:681` | Padding based input height | 4, Form controls |
| Settings | Boolean control | `app/(cockpit)/settings/setting-control.tsx:41` | closed in D3-D | 4, Form controls |
| Settings | Select | `app/(cockpit)/settings/setting-control.tsx:96` | closed in D3-D | 4, Select |
| Settings | Save buttons | `app/(cockpit)/settings/settings-group-form.tsx:331` | closed in D3-D | 4, Buttons |
| Health | Scan button | `components/cockpit/screens/health.tsx:186` | closed in D3-C | 2 and 4, colour and Buttons |
| Health | Status badges | `components/cockpit/screens/health.tsx:329` | closed in D3-C | 4, Status chips |
| Health | Timeline cards | `components/cockpit/screens/health.tsx:232` | Repeats panel recipe | 4, Cards |
| Users | Tables | `components/cockpit/screens/users.tsx:256` | Two private wide table skins | 4, Data tables |
| Users | Input | `components/cockpit/screens/users.tsx:515` | closed in D3-C | 4, Form controls |
| Users | Modal | `components/cockpit/screens/users.tsx:688` | closed in D3-C | 4 and 6, Modal |
| Mobile cockpit | Bottom tabs | `components/cockpit/mobile/bottom-tab-bar.tsx:21` | closed in D3-C | 4, Tabs |
| Mobile cockpit | More sheet | `components/cockpit/mobile/mobile-sheet.tsx:45` | closed in D3-C | 4, Modal and drawer |
| Mobile cockpit | Overview cards | `components/cockpit/mobile/screens/overview-mobile.tsx:107` | Invisible overlay button covers card | 4, Buttons |
| Loading routes | Skeleton Block | `app/overview-skeleton.tsx:2` | Duplicates shared Block helper | 4, Skeletons |
| Loading routes | Skeleton motion | `app/skeleton-block.tsx:3` | Pulse has no reduced motion rule | 4, Skeletons |

The table contains 61 gap rows. It is an inventory, not an instruction to fix
all gaps in one change. Later stages should migrate one primitive and its named
consumers at a time, then remove the corresponding rows.
