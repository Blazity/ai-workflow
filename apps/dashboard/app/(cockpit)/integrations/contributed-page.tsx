import { integrationManifest } from "@integrations/registry";
import { integrationDashboardPages, loadIntegrationPage } from "@integrations/registry/dashboard";

import { CONNECTION_PAGE, integrationHref } from "@/lib/cockpit/navigation";
import { readIntegrationsList } from "@/lib/integrations/list";
import { readContributedPageData } from "@/lib/integrations/page-data";
import { contributedPageOutcome } from "@/lib/integrations/presentation";

/**
 * A page an integration contributes, rendered as one of our own.
 *
 * What it shows is decided by `contributedPageOutcome`, which is where the
 * sentences live; this reads the three facts that decision needs, and none of
 * them costs an integration module: the manifest is plain data and the page ids
 * are plain data. The integration's own code is loaded after the decision, so
 * an integration nobody has connected contributes nothing that runs.
 *
 * The component is then handed the integration id and what its own reader
 * returned, which is all its props carry; ADR-010 is honest about what a Server
 * Component in our process can still reach, and about the gate that keeps the
 * obvious routes shut.
 */
function AreaNotice({
  title,
  body,
  href,
  action,
}: {
  title: string;
  body: string;
  href: string;
  action: string;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 lg:px-6 pt-5 pb-8 max-w-[640px]">
      <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
        {title}
      </h2>
      <p className="m-0 font-body text-[13px] text-neutral-600">{body}</p>
      <a
        href={href}
        className="font-mono text-[11px] font-medium tracking-[0.04em] text-mariner no-underline hover:underline"
      >
        {action}
      </a>
    </div>
  );
}

export async function ContributedPage({ id, pageId }: { id: string; pageId: string }) {
  const manifest = integrationManifest(id);
  // The area layout already said there is no such integration, and saying it
  // twice on one screen reads as two different problems.
  if (!manifest) return null;

  const list = await readIntegrationsList();
  const outcome = contributedPageOutcome({
    manifest,
    pageId,
    hasComponent: integrationDashboardPages(id).includes(pageId),
    integration: list?.integrations.find((candidate) => candidate.id === id),
    workerAnswered: list !== null,
  });

  if (outcome.kind === "notice") {
    const connection = outcome.action === "connection";
    return (
      <AreaNotice
        title={outcome.title}
        body={outcome.body}
        href={connection ? integrationHref(id, CONNECTION_PAGE.id) : integrationHref(id)}
        action={connection ? "Open Connection ->" : "Open the integration ->"}
      />
    );
  }

  const Contributed = await loadIntegrationPage(id, pageId);
  if (!Contributed) {
    // The ids said this page exists and the module disagreed, which means the
    // entry was built from a different commit than the manifest.
    return (
      <AreaNotice
        title="This page did not ship"
        body={`${manifest.name} declares ${outcome.label}, and the screen behind it is missing from this build. The build is inconsistent with the integration; re-running the registry generator is what fixes it.`}
        href={integrationHref(id)}
        action="Open the integration ->"
      />
    );
  }
  // Resolved before the page renders, through the integration's own reader.
  // A page has no client of ours and no session, so this is the whole of what
  // it can see beyond what its package ships.
  const data = await readContributedPageData(id, pageId);
  return <Contributed integrationId={id} data={data} />;
}
