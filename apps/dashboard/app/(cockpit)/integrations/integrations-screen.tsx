import type {
  IntegrationCapabilityDto,
  IntegrationDto,
  IntegrationWriteAccess,
  SystemHealthResponse,
} from "@shared/contracts";

import { IntegrationChangeRefresh } from "@/components/cockpit/integration-change-refresh";
import { Button, CkChip } from "@/components/ui";
import {
  CORE_CAPABILITIES_LINE,
  MEMBER_READ_ONLY_LINE,
  NO_INTEGRATIONS_LINE,
  builtinProviderLines,
  capabilitiesUnreadLine,
  capabilityCardinalityLine,
  capabilityHeading,
  capabilityServingLine,
  statusChip,
  statusDetailLines,
  storesValues,
  unlocksLines,
  workerUnreachableLine,
  type BlockAvailability,
  type CapabilitiesUnread,
  type IntegrationTone,
} from "@/lib/integrations/presentation";

/**
 * Every integration this build ships, at a glance.
 *
 * The list reads and never writes. Every control that changes a connection
 * lives on one screen per integration, so there is exactly one place where a
 * credential is typed and exactly one place where a destructive action is
 * confirmed. A member gets the same list and the same link, and the screen it
 * opens shows the state without controls.
 */

const CHIP_TONES: Record<IntegrationTone, "success" | "failed" | "neutral" | "blocked"> = {
  success: "success",
  failed: "failed",
  quiet: "blocked",
  off: "neutral",
};

/** Not connected is quiet and dashed; disabled is solid, because somebody
 *  chose it. The two must not read as the same thing at a glance. */
const CARD_EDGES: Record<IntegrationTone, string> = {
  success: "border border-neutral-200",
  failed: "border border-[#F0B8AE]",
  quiet: "border border-dashed border-neutral-300",
  off: "border border-neutral-300",
};

function IntegrationCard({
  integration,
  canManage,
  availability,
  scan,
}: {
  integration: IntegrationDto;
  canManage: boolean;
  availability?: BlockAvailability;
  scan: SystemHealthResponse | null;
}) {
  const chip = statusChip(integration.state);
  const href = `/integrations/${encodeURIComponent(integration.id)}/connection`;
  const stored = storesValues(integration);

  return (
    <li className={`rounded-[4px] bg-panel px-4 py-3 ${CARD_EDGES[chip.tone]}`}>
      {/* Stacked on a phone: at 390 px the two columns squeezed the description
          into a third of the width while the action kept the rest. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={href}
              className="font-display text-[15px] font-medium text-coal no-underline hover:underline"
            >
              {integration.name}
            </a>
            <CkChip tone={CHIP_TONES[chip.tone]}>{chip.label}</CkChip>
          </div>
          <p className="m-0 mt-1 font-body text-[12px] text-neutral-600">
            {integration.description}
          </p>
          <div className="mt-1 flex flex-col gap-[2px]">
            {statusDetailLines(integration, scan).map((line, index) => (
              <span key={index} className="font-body text-[11px] text-neutral-500 break-words">
                {line}
              </span>
            ))}
          </div>
          <div className="mt-2 flex flex-col gap-[2px]">
            {unlocksLines(integration, availability).map((line, index) => (
              <span key={index} className="font-body text-[11px] text-neutral-700 break-words">
                {line}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          {/* A deployment with nothing configured has one job on this card, so
              it gets the one control that looks like one. Anything already
              configured is being visited, not set up, and a quiet link keeps
              the list readable. */}
          {canManage && !stored && integration.state.environment.setVariables.length === 0 ? (
            <Button href={href} variant="primary" size="sm">
              Connect
            </Button>
          ) : (
            <a
              href={href}
              className="font-mono text-[11px] font-medium tracking-[0.04em] text-mariner no-underline hover:underline"
            >
              {canManage ? "Manage connection" : "View connection"}
            </a>
          )}
          {integration.docsUrl && (
            <a
              href={integration.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500 no-underline hover:underline"
            >
              Provider docs
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

/** Where what a built-in provider holds can be read, by capability. */
const BUILTIN_SCREENS: Readonly<Record<string, { href: string; label: string }>> = {
  memory: { href: "/memory", label: "Open Memory" },
};

/**
 * The built-in provider of a capability, where an integration would have its
 * card: named, said to be ours, and with no field, test or switch, because it
 * has none.
 */
function BuiltinProviderCard({
  capability,
  name,
  nameOf,
}: {
  capability: IntegrationCapabilityDto;
  name: string;
  nameOf: (id: string) => string;
}) {
  const screen = BUILTIN_SCREENS[capability.id];
  return (
    <div className="mt-2 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-[13px] font-medium text-coal">{name}</span>
        <CkChip tone="neutral">Built in</CkChip>
      </div>
      {builtinProviderLines(capability, nameOf).map((line, index) => (
        <span key={index} className="font-body text-[11px] text-neutral-600 break-words">
          {line}
        </span>
      ))}
      {screen && (
        <a
          href={screen.href}
          className="self-start font-mono text-[11px] font-medium tracking-[0.04em] text-mariner no-underline hover:underline"
        >
          {screen.label}
        </a>
      )}
    </div>
  );
}

/**
 * What core asks a provider for, and which one answers here.
 *
 * Above the cards, because it is the answer to the question the cards only
 * imply: an admin looking for "what does memory run on" found a list of
 * integrations, none of which serves memory, and no mention of the provider
 * that does. Every sentence is the worker's decision put into words; nothing
 * here works out who serves what from the cards.
 */
function CapabilitiesSection({
  capabilities,
  integrations,
}: {
  capabilities: readonly IntegrationCapabilityDto[] | CapabilitiesUnread;
  integrations: readonly IntegrationDto[];
}) {
  const nameOf = (id: string) =>
    integrations.find((integration) => integration.id === id)?.name ?? id;
  return (
    <section aria-labelledby="integrations-capabilities" className="flex flex-col gap-2">
      <div className="flex flex-col gap-[2px]">
        <h3
          id="integrations-capabilities"
          className="m-0 font-display text-[16px] font-medium text-coal"
        >
          Capabilities
        </h3>
        <p className="m-0 font-body text-[12px] text-neutral-600">
          What the product asks a provider for, and which one answers on this deployment.
        </p>
      </div>
      {typeof capabilities === "string" ? (
        <p className="m-0 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          {capabilitiesUnreadLine(capabilities)}
        </p>
      ) : (
        <ul className="list-none m-0 p-0 rounded-[4px] border border-neutral-200 bg-panel divide-y divide-neutral-200">
          {capabilities.map((capability) => (
            <li
              key={capability.id}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="shrink-0 sm:w-[168px]">
                <div className="font-display text-[14px] font-medium text-coal">
                  {capabilityHeading(capability)}
                </div>
                <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
                  {capabilityCardinalityLine(capability)}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <p className="m-0 font-body text-[12px] text-neutral-700 break-words">
                  {capabilityServingLine(capability, nameOf)}
                </p>
                {capability.serving.kind === "builtin" && (
                  <BuiltinProviderCard
                    capability={capability}
                    name={capability.serving.name}
                    nameOf={nameOf}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function IntegrationsScreen({
  integrations,
  writes,
  canManage,
  available,
  availability,
  capabilities = "unreadable",
  scan = null,
}: {
  integrations: readonly IntegrationDto[];
  writes: IntegrationWriteAccess;
  /** canManageIntegrations(role): owners and admins. */
  canManage: boolean;
  /** False when the worker did not answer the read. */
  available: boolean;
  /** Which of the declared blocks this build can run, when that was readable. */
  availability?: BlockAvailability;
  /** Who serves each capability, or why the worker did not say. */
  capabilities?: readonly IntegrationCapabilityDto[] | CapabilitiesUnread;
  /** The last stored health scan, when this role could read one. */
  scan?: SystemHealthResponse | null;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      {/* A colleague disconnecting something in another tab leaves every status
          on this list wrong, and the list is the screen people leave open. */}
      <IntegrationChangeRefresh />
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          Integrations
        </div>
        <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
          What this deployment can talk to
        </h2>
        <p className="m-0 font-body text-[13px] text-neutral-600">
          {CORE_CAPABILITIES_LINE}
        </p>
      </div>

      {!available && (
        <div className="rounded-[3px] border border-[#F0B8AE] bg-fail-bg px-3 py-2 font-body text-[12px] text-fail-fg">
          {workerUnreachableLine(canManage)}
        </div>
      )}

      {available && canManage && !writes.allowed && (
        <div
          role="status"
          className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[12px] text-[#A23E18]"
        >
          {writes.reason} Everything below is readable; nothing here can be changed
          from this deployment.
        </div>
      )}

      {available && !canManage && (
        <div className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          {MEMBER_READ_ONLY_LINE}
        </div>
      )}

      {available && (
        <CapabilitiesSection capabilities={capabilities} integrations={integrations} />
      )}

      {available && integrations.length === 0 && (
        <div className="rounded-[3px] border border-dashed border-neutral-300 px-4 py-8 text-center">
          <p className="m-0 mx-auto max-w-[52ch] font-body text-[13px] text-neutral-600">
            {NO_INTEGRATIONS_LINE}
          </p>
        </div>
      )}

      {available && integrations.length > 0 && (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              canManage={canManage}
              availability={availability}
              scan={scan}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
