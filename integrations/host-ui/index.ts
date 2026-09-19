/**
 * The UI an integration's dashboard pages are built from.
 *
 * Two halves. `contract` is how a package declares which component serves which
 * page its manifest names. `primitives` is the look: presentational components
 * on the cockpit's own tokens, so a contributed page is indistinguishable from
 * a screen core wrote.
 *
 * This package exists so an integration never imports `@/components/ui`. That
 * alias is the dashboard's own, it changes whenever a screen needs it to, and
 * an integration pinned to it would break on an afternoon nobody told them
 * about. What is exported here is a contract: it grows by addition and the
 * boundaries gate is what keeps everything else out of reach.
 *
 * What it deliberately does not export, and why:
 *
 * - **No dialog, overlay, drawer or portal.** A page renders inside the
 *   cockpit's content area. Anything that escapes that box is an integration
 *   taking the screen away from the product.
 * - **No navigation.** No router, no internal link, no redirect. Where a person
 *   is in the product is the product's to decide; `ExternalLink` leaves to the
 *   provider and says so.
 * - **No form controls.** A contributed page has no way to write anything in
 *   this build, and a control that does nothing when clicked is worse than no
 *   control. The stage that gives pages a write seam brings the controls with
 *   it.
 * - **No `className` on any primitive.** A page composes primitives with its
 *   own elements, and writes its own Tailwind classes, arbitrary values
 *   included, on those. Redressing a primitive is how two screens come to
 *   disagree about what a card looks like.
 * - **No session, no data access, no client in the props.** A page is a Server
 *   Component in the cockpit's own process, so this is a contract rather than
 *   a sandbox: see `IntegrationPageProps` for what that means and for the
 *   imports the boundaries gate refuses.
 */
export {
  defineIntegrationDashboard,
  type ErasedIntegrationDashboard,
  type ErasedIntegrationDashboardEntry,
  type IntegrationDashboard,
  type IntegrationDashboardPages,
  type IntegrationPageComponent,
  type IntegrationPageProps,
} from "./contract";

export {
  Card,
  Chip,
  EmptyState,
  ExternalLink,
  KeyValue,
  Notice,
  Page,
  Section,
  Table,
  type HostTone,
  type KeyValueItem,
  type TableColumn,
  type TableRow,
} from "./primitives";
