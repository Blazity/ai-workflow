/**
 * What the cockpit's navigation is, as data.
 *
 * Two answers come from one table here: which entries the sidebar carries, and
 * what the screen at a given path is. They were the same question when every
 * screen was `/<id>` and the shell could read the first path segment and call
 * it the screen. Two areas broke that: Settings now holds System health and
 * Users, and an integration holds its own pages. A first segment says
 * "settings" for a screen whose whole point is that nothing may poll it, and
 * "integrations" for a page belonging to a named integration.
 *
 * So the shell asks this module instead, and gets the three things it actually
 * needs: which sidebar entry is lit, what the topbar says, and whether the
 * cockpit's refresh loop may touch this screen.
 */

/**
 * Whether a click on an in-cockpit link belongs to the browser: a modified or
 * non-primary click opens a tab or a window, and the link is a real anchor so
 * that it can. A plain click is the cockpit's, and goes through its guarded
 * `navigate` instead of leaving the document.
 */
export function browserHandlesClick(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly button: number;
}): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

/** One integration as the chrome needs it: name, pages, and whether it is in use. */
export interface CockpitIntegration {
  readonly id: string;
  readonly name: string;
  readonly pages: readonly { readonly id: string; readonly label: string }[];
  /** Connected and enabled. Only these get a sidebar entry. */
  readonly usable: boolean;
}

export interface NavEntry {
  readonly id: string;
  readonly label: string;
  /** One or two characters in the collapsed rail, where there is no room for a name. */
  readonly glyph: string;
  readonly href: string;
  /** The topbar's words when they differ from the sidebar's. */
  readonly title?: string;
}

export interface NavGroup {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly NavEntry[];
}

/** The core product's own screens. Integrations are appended below a separator. */
export const CORE_NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "obs",
    label: "Observability",
    entries: [
      { id: "overview", label: "Overview", glyph: "◇", href: "/" },
      { id: "runs", label: "Workflow runs", glyph: "≡", href: "/runs" },
      { id: "approvals", label: "Approvals", glyph: "⚖", href: "/approvals" },
      { id: "prompts", label: "Prompts", glyph: "❡", href: "/prompts" },
      { id: "memory", label: "Memory", glyph: "❖", href: "/memory", title: "Agent memory" },
      { id: "cost", label: "Cost & usage", glyph: "$", href: "/cost" },
    ],
  },
  {
    id: "flow",
    label: "Workflow",
    entries: [
      { id: "editor", label: "Workflow editor", glyph: "▷", href: "/editor" },
      { id: "profiles", label: "Harness profiles", glyph: "⌘", href: "/profiles" },
      { id: "repositories", label: "Repositories", glyph: "☑", href: "/repositories" },
    ],
  },
  {
    id: "team",
    label: "Administration",
    entries: [
      // Never role gated: reading what this deployment is configured to do is
      // open to every role, and only the forms on a screen are owner and admin
      // only. System health and Users are tabs of this area, not entries of
      // their own: they are things an administrator does, and thirteen flat
      // entries left no room for the integrations below.
      { id: "settings", label: "Settings", glyph: "⚙", href: "/settings" },
    ],
  },
];

export const INTEGRATIONS_GROUP_LABEL = "Integrations";

/** The entry every deployment has, connected integrations or not. */
const INTEGRATIONS_INDEX_ENTRY: NavEntry = {
  id: "integrations",
  label: "All integrations",
  glyph: "⇄",
  href: "/integrations",
  title: "Integrations",
};

/** The core tab of every integration's area, which S6 owns. */
export const CONNECTION_PAGE = { id: "connection", label: "Connection" } as const;

export function integrationHref(id: string, pageId?: string): string {
  const base = `/integrations/${encodeURIComponent(id)}`;
  return pageId === undefined ? base : `${base}/${encodeURIComponent(pageId)}`;
}

/**
 * Two characters for the collapsed rail: the name's first letter, then its next
 * capital, or its second letter when it has no other capital.
 *
 * Nothing in a manifest gives us a symbol, and the five providers coming next
 * are camel-cased brands, so the second capital is what tells them apart:
 * GitHub is GH and GitLab is GL, where a first letter alone would have made
 * both G. Holding the first letter fixed is what keeps the mark stable when a
 * name is recased (`Mem0` and `mem0` both read ME), and a name with no Latin
 * letters keeps its own first two characters rather than becoming a pair of
 * question marks. It is a mark, not an abbreviation: `OpenAI` reads OA, which
 * is stable and unique, which is the whole job. Two integrations could still
 * collide; every entry carries the full name as `title` and `aria-label`, and
 * the answer if that stops being enough is a glyph in the manifest, which is an
 * additive change.
 */
export function integrationMonogram(name: string): string {
  const characters = [...name.trim()].filter((character) => /[\p{L}\p{N}]/u.test(character));
  const first = characters[0];
  if (first === undefined) return "??";
  const rest = characters.slice(1);
  // The first letter always, and after it the name's next capital when it has
  // one. That is what keeps GitHub and GitLab apart without making the mark
  // depend on how the rest of the name is cased: Mem0 and mem0 both read ME.
  const second = rest.find((character) => /\p{Lu}/u.test(character)) ?? rest[0] ?? "";
  return (first + second).toUpperCase();
}

/** The Integrations section: the page itself, then one entry per usable integration. */
export function integrationNavEntries(
  integrations: readonly CockpitIntegration[],
): readonly NavEntry[] {
  return [
    INTEGRATIONS_INDEX_ENTRY,
    ...integrations
      .filter((integration) => integration.usable)
      .map((integration) => ({
        id: `integration:${integration.id}`,
        label: integration.name,
        glyph: integrationMonogram(integration.name),
        href: integrationHref(integration.id),
      })),
  ];
}

const CORE_ENTRIES = CORE_NAV_GROUPS.flatMap((group) => group.entries);
const CORE_BY_ID = new Map(CORE_ENTRIES.map((entry) => [entry.id, entry]));

/** Screens with no sidebar entry of their own, reached from a row or a search. */
const DETAIL_TITLES: Readonly<Record<string, string>> = {
  trace: "Run trace",
  ticket: "Ticket runs",
};

export interface CockpitScreen {
  /** The sidebar entry to light. `integration:<id>` for an integration's area. */
  readonly navId: string;
  /** The topbar and the mobile header. */
  readonly title: string;
  /**
   * False where the cockpit's timer must not refresh. Health probes contact
   * every configured provider, so that screen is asked only when somebody asks
   * it; a persisted Live preference must not turn one open tab into a
   * continuous fan-out of production requests.
   */
  readonly allowsLivePolling: boolean;
}

const OVERVIEW: CockpitScreen = { navId: "overview", title: "Overview", allowsLivePolling: true };
const SETTINGS: CockpitScreen = { navId: "settings", title: "Settings", allowsLivePolling: true };

/** Where a sidebar entry's id leads. The inverse of `cockpitScreen`. */
export function hrefForNavId(navId: string): string {
  if (navId.startsWith("integration:")) return integrationHref(navId.slice("integration:".length));
  return CORE_BY_ID.get(navId)?.href ?? INTEGRATIONS_INDEX_ENTRY.href;
}

/**
 * What screen a path is.
 *
 * `integrations` is every integration this deployment ships, usable or not: a
 * card on the Integrations list opens an integration nobody has connected yet,
 * and that screen still has to say whose it is.
 */
export function cockpitScreen(
  pathname: string,
  integrations: readonly CockpitIntegration[] = [],
): CockpitScreen {
  const segments = pathname.replace(/^\/+/u, "").split("/").filter(Boolean);
  const [first, second, third] = segments;
  if (!first) return OVERVIEW;

  if (first === "settings") {
    // A segment past the tab is not a screen of this area: it is a 404, and the
    // topbar has to say what rendered rather than what the URL hoped for.
    if (segments.length > 2) return SETTINGS;
    if (second === "health") {
      return { navId: "settings", title: "System health", allowsLivePolling: false };
    }
    if (second === "users") return { navId: "settings", title: "Users", allowsLivePolling: true };
    return SETTINGS;
  }

  if (first === "integrations") {
    const integration =
      second && segments.length <= 3
        ? integrations.find((candidate) => candidate.id === second)
        : undefined;
    if (!integration) {
      return { navId: "integrations", title: INTEGRATIONS_INDEX_ENTRY.title!, allowsLivePolling: true };
    }
    const page =
      third === CONNECTION_PAGE.id
        ? CONNECTION_PAGE
        : integration.pages.find((candidate) => candidate.id === third);
    return {
      navId: `integration:${integration.id}`,
      title: page ? `${integration.name} / ${page.label}` : integration.name,
      allowsLivePolling: true,
    };
  }

  const core = CORE_BY_ID.get(first);
  if (core) return { navId: core.id, title: core.title ?? core.label, allowsLivePolling: true };
  return { navId: first, title: DETAIL_TITLES[first] ?? "AI Workflow", allowsLivePolling: true };
}

/** The three screens the phone's bottom bar carries; everything else is under More. */
const MOBILE_PRIMARY_NAV_IDS = ["overview", "runs", "editor"] as const;

export function isMobileMoreNavItem(navId: string): boolean {
  return !(MOBILE_PRIMARY_NAV_IDS as readonly string[]).includes(navId);
}
