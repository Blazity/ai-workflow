Status: current
Last-verified: 2026-09-14

# DESIGN.md: AI Workflow dashboard

> The written source of truth for dashboard tokens and shared UI primitives.
> Read this before changing a token or primitive. Screen layout and page
> composition remain owned by their screens.

## 0. Scope

This file governs the dashboard theme, visual tokens, typography, and shared
primitives in `apps/dashboard/components/ui/` and
`apps/dashboard/components/ui.tsx`.

It does not prescribe screen markup, page grids, responsive layout, gutters,
table composition, toolbar composition, or navigation placement. A screen may
compose primitives and preserve its own layout without turning that layout
into a design system rule. The existing code remains the runtime fact.

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

### Rule zero: the shared component is the design system

The shared primitive owns its appearance and interactive state. A caller
chooses a component, variant, and size. It may use `className` for placement,
width, or documented extension points, but it must not recreate the primitive
skin from utility classes.

Use the exports from `apps/dashboard/components/ui`. Keep native controls
inside their primitive. Keep behavior and visual treatment together. A domain
wrapper may add copy or map data, but it does not define another skin.

`pnpm run gate:ui-primitives` enforces this boundary over dashboard source. It
forbids native form controls outside primitives, literal motion durations,
`transition-all`, animation timers with literal delays, and boolean selection
expressed with the `primary` Button variant.

### Button and IconButton

`Button` renders a native button or an anchor when `href` is supplied. It owns
loading state, disabled state, optional leading content, focus treatment, and
the compact control geometry. `IconButton` uses the same class builder, always
requires an accessible label, and normally applies square icon sizing.

| Variant | Built appearance | Use |
| --- | --- | --- |
| `primary` | Mariner fill, white text, compact border and radius | The main confirm or create action |
| `selected` | Mariner tint, mariner border and text | A selected or pressed toggle |
| `secondary` | Panel fill, neutral border, coal text | An alternative or cancel action |
| `ghost` | Transparent fill and border | A quiet action that still needs button geometry |
| `danger` | Solid fail treatment | A destructive or irreversible action |
| `success` | Solid emerald treatment | A positive operational action such as deploy |
| `danger-soft` | Soft red fill, red border, red text, pill radius | An actionable error status |
| `text` | No border, background, padding, height, radius, font, colour, or press scale | A baseline text action whose typography and colour come from `className` |

The `sm` size is 26 px high with 8 px horizontal padding. The `md` size is
30 px high with 12 px horizontal padding. Icon only controls use the matching
26 px or 30 px square.

The `text` variant deliberately ignores size classes and IconButton icon only
sizing. It keeps `inline-flex`, vertical centering, a 6 px content gap, the
focus ring, and disabled opacity. It also ignores IconButton circle shape so
the caller receives no implicit radius.

Use `selected` for boolean selection. Use `ghost` when the action needs normal
button geometry. Use `text` only when existing text typography and colour must
remain in control of the caller.

Implemented by `components/ui/button.tsx` and
`components/ui/icon-button.tsx`.

### Select

`Select` composes the shared `Listbox` behavior. Its option model carries a
string value, visible label, optional hint, and optional disabled state. It
forwards IDs, accessible naming and description, invalid state, disabled
state, and caller width or placement classes.

| Size | Built appearance | Use |
| --- | --- | --- |
| `compact` | 26 px trigger | Dense form rows |
| `default` | 30 px trigger with panel background | Standard forms and filters |

Arrow keys move through enabled options. Home and End reach the first and last
enabled options. Escape closes the menu and restores focus. Disabled options
remain visible and cannot be selected.

Use `Field` for a visible label. Use `aria-label` only when no visible label is
available.

Implemented by `components/ui/select.tsx`.

### Input, Textarea, and Field

`Input` is the canonical single line native input. `Textarea` carries the same
border, focus, invalid, disabled, typography, and density rules for multiline
content. `Field` owns the visible label, optional hint, persistent error,
required marker, and the IDs that connect those elements to the control.

| Primitive or variant | Built appearance | Use |
| --- | --- | --- |
| Input `sm` | 26 px high | Compact text, number, URL, or identifier entry |
| Input `md` | 30 px high | Standard single line entry |
| Textarea `sm` | 72 px minimum height | Compact multiline entry |
| Textarea `md` | 88 px minimum height | Standard multiline entry |
| `monospace` | JetBrains Mono instead of body type | IDs, refs, commands, and code shaped values |
| Textarea `resize="none"` | Fixed caller controlled geometry | A composed panel that owns the textarea height |
| Textarea `resize="y"` | Vertical resize handle | User controlled prose height |

Default controls use a panel background, neutral edge, 3 px radius, 8 px
horizontal padding, coal text, and neutral placeholder text. Focus uses the
shared mariner ring. Invalid state uses the fail edge and must be paired with
linked error text through `Field`.

Implemented by `components/ui/input.tsx`,
`components/ui/textarea.tsx`, and `components/ui/field.tsx`.

### Checkbox

`Checkbox` wraps a native checkbox in a block level `flex` label with vertical
centering, an 8 px gap, body typography, and caller `className` pass through.
The input is a 12 px square with a 2 px radius and mariner accent. It supports
disabled and indeterminate states.

Use Checkbox for an independent binary choice or each item in a checkbox
group. The block level wrapper preserves vertical stacking and margin
utilities. When an existing composition is intentionally inline, the caller
may add `inline-flex w-fit` through `className`.

Implemented by `components/ui/checkbox.tsx`.

### Radio

`Radio` wraps a native radio in the same block level `flex` label and text
recipe as Checkbox. The input is a 12 px circle with mariner accent.

Use Radio when one choice must be selected from a named group. Give every
member the same native `name`. The block level wrapper preserves vertical
stacking. An intentionally inline composition may add `inline-flex w-fit`
through `className`.

Implemented by `components/ui/radio.tsx`.

### Switch

`Switch` is a button with `role="switch"` and `aria-checked`. It uses a 32 px by
18 px rounded track, a 14 px thumb, and an inline flex wrapper. Click, Space,
and Enter toggle it. Disabled state blocks changes.

Use Switch for a setting that takes effect as an enabled or disabled state.
Use Checkbox for selection inside a form or list. Switch keeps its inline
wrapper and accepts visible children or an accessible label.

Implemented by `components/ui/switch.tsx`.

### Modal

`Modal` owns the overlay, dialog semantics, focus management, dismissal,
animation state, body scroll lock, cockpit main inert state, and focus restore.
Nested open modals share reference counted scroll and inert locks. Only the
topmost open dialog handles Escape and focus trapping.

| Prop or variant | Built behavior | Use |
| --- | --- | --- |
| `chrome="default"` | Shared header, scrollable body, optional footer and close button | A dialog using canonical shared chrome |
| `chrome="none"` | Children become the complete visible panel content | A dialog that must preserve its own header, tabs, body, or footer |
| `size="sm"` | 476 px maximum width | Compact dialog |
| `size="md"` | 680 px maximum width | Standard dialog |
| `size="lg"` | 1240 px maximum width | Wide dialog |
| `variant="center"` | Centered panel | Standard desktop dialog |
| `variant="drawer"` | Right edge panel | Side drawer |
| `variant="sheet"` | Bottom edge panel | Mobile sheet |
| `variant="command"` | High centered panel | Command or spotlight dialog |

Default chrome requires `title`. Chrome none requires either `title` or
`aria-label`. When chrome none receives a title, Modal keeps a visually hidden
heading for `aria-labelledby`. When it has no title, `aria-label` names the
dialog. Optional description remains available to assistive technology.

`className` applies to the dialog panel and may reproduce an established panel
width or height. `frameClassName` applies to the fixed placement frame. `size`
continues to apply in both chrome modes. Chrome none does not render the shared
header, body wrapper, footer, close button, or sheet handle.

A dismissible modal closes on an unhandled Escape key or a mouse down whose
target is the overlay itself. It does not close from panel mouse down or a drag
that merely ends over the overlay. `initialFocusRef` takes precedence over
`data-dialog-initial-focus`, then the first focusable element.

Implemented by `components/ui/modal.tsx`.

## 5. Primitive geometry and composition

Shared size props define control geometry. Callers should choose the closest
existing size instead of recreating heights and padding.

| Token or primitive value | Role |
| --- | --- |
| 2 px radius | Checkbox and compact semantic treatment |
| 3 px radius | Button, Input, Textarea, and Select trigger |
| 4 px radius | Select menu and other floating control panels |
| 6 px radius | Default Modal panel |
| 16 px top radius | Modal sheet |
| 6 px gap | Button and Switch content |
| 8 px gap | Checkbox and Radio label |
| 26 px height | Compact Button, IconButton, Input, and Select |
| 30 px height | Default Button, IconButton, Input, and Select |

`className` may set width, external margin, parent alignment, or a documented
escape hatch. It must not replace focus, disabled, invalid, loading, or
selection behavior. Two intentional appearance escape hatches exist:
`Button variant="text"` delegates its font and colour to the caller, and
`Modal chrome="none"` delegates visible panel chrome to its children.

## 6. Primitive motion and depth

Depth communicates stacking. Form controls and buttons use an edge rather than
a shadow. Select menus use the existing popover shadow. Modal panels use the
modal shadow and their overlay uses coal at 40 percent opacity.

Interactive colour changes use `--motion-fast`. Standard modal overlay exit
uses `--motion-base`. Modal panel entry uses `--motion-slow` and exit uses
`--motion-base`. Motion classes name the properties they animate and never use
`transition-all`.

Focus rings are interaction state, not elevation. Button, IconButton, Input,
Textarea, Checkbox, Radio, and Switch keep the visible 2 px mariner focus ring.
Reduced motion makes duration tokens zero and stops continuous primitive
animation.

## 7. Primitive usage rules

1. Use the shared primitive instead of a raw native control at a call site.
2. Use `primary` for the main action and `selected` for boolean selection.
3. Use `text` only when the caller must preserve established text typography
   and colour without button geometry.
4. Use `success` for a positive operational action and `danger-soft` for an
   actionable error status.
5. Put visible labels, hints, and errors through `Field` when the control shape
   permits it.
6. Keep Checkbox and Radio block level by default. Add `inline-flex w-fit` only
   where the surrounding composition is intentionally inline.
7. Keep Switch inline and use it for enabled state, not grouped selection.
8. Use default Modal chrome when its header, body, and footer structure fits.
   Use chrome none when the complete existing dialog structure must remain.
9. Give every dialog an accessible name through `title` or the required
   `aria-label` in chrome none.
10. Use named colour and motion tokens. Do not add raw colour or literal
    duration values at primitive call sites.
