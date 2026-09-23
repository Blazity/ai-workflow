/**
 * Values a provider field may be handed, chosen at the edges of the integration
 * id rule (`INTEGRATION_ID` in `@shared/contracts`): its length bounds, the two
 * separators the wider rule it replaced admitted, a leading digit, upper case
 * and surrounding space. A test that holds a copy of the rule equal to the
 * contract runs every probe through both and compares the answers, so the
 * expected value is always the contract's and never written here.
 */
export const PROVIDER_ID_PROBES: readonly string[] = [
  "github",
  "gitlab",
  "abc",
  `a${"b".repeat(31)}`,
  "ab",
  `a${"b".repeat(32)}`,
  "git-hub",
  "git_hub",
  "1github",
  "GitHub",
  " github ",
  "",
];
