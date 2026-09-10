export async function loadEnvironmentPort() {
  const environment = await import("../../config/env.js");
  return {
    get env() {
      return environment.env;
    },
    get getConfiguredVcsProviders() {
      return environment.getConfiguredVcsProviders;
    },
  };
}

export async function loadAdaptersPort() {
  const { createAdapters } = await import("../../services/vcs/adapters.js");
  return { createAdapters };
}

export async function loadActiveRunOwnerPort() {
  const { assertActiveRunOwner } = await import("../../services/run-lifecycle/active-run-owner.js");
  return { assertActiveRunOwner };
}

export async function loadRepositoryDiscoveryPort() {
  const repositoryDiscovery = await import("../../services/repository-discovery/runner.js");
  return {
    get REPOSITORY_DISCOVERY_SCHEMA() {
      return repositoryDiscovery.REPOSITORY_DISCOVERY_SCHEMA;
    },
    get assembleRepositoryDiscoveryPrompt() {
      return repositoryDiscovery.assembleRepositoryDiscoveryPrompt;
    },
    get isExpansionLimitClarification() {
      return repositoryDiscovery.isExpansionLimitClarification;
    },
    get validateHumanRepositoryExpansion() {
      return repositoryDiscovery.validateHumanRepositoryExpansion;
    },
    get validateRepositoryExpansionRequests() {
      return repositoryDiscovery.validateRepositoryExpansionRequests;
    },
  };
}

export async function loadRunTelemetryPort() {
  const runTelemetry = await import("../../services/telemetry/run-telemetry.js");
  return {
    get markRunFailedOnSelfMove() {
      return runTelemetry.markRunFailedOnSelfMove;
    },
    get markRunSucceededOnSelfMove() {
      return runTelemetry.markRunSucceededOnSelfMove;
    },
    get recordBlockStatuses() {
      return runTelemetry.recordBlockStatuses;
    },
    get recordRunStatusReason() {
      return runTelemetry.recordRunStatusReason;
    },
    get recordRunUsage() {
      return runTelemetry.recordRunUsage;
    },
  };
}

export async function loadTicketTransitionPort() {
  const { moveTicketForRun } = await import("../../services/tickets/ticket-transition.js");
  return { moveTicketForRun };
}

export async function loadVcsRuntimePort() {
  const vcsRuntime = await import("../../services/vcs/vcs-runtime.js");
  return {
    get buildSandboxProviderConfigs() {
      return vcsRuntime.buildSandboxProviderConfigs;
    },
    get createRepositoryVCS() {
      return vcsRuntime.createRepositoryVCS;
    },
  };
}

export type ActiveRunOwner = Parameters<
  Awaited<ReturnType<typeof loadActiveRunOwnerPort>>["assertActiveRunOwner"]
>[1];

export type RepositoryExpansionDecision = ReturnType<
  Awaited<
    ReturnType<typeof loadRepositoryDiscoveryPort>
  >["validateRepositoryExpansionRequests"]
>;

export type TicketTransitionOwner = Parameters<
  Awaited<ReturnType<typeof loadTicketTransitionPort>>["moveTicketForRun"]
>[0]["owner"];
