export async function loadEnvironmentPort() {
  const environment = await import("../../infra/vcs-config.js");
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
  const { createAdapters } = await import("../support/adapters.js");
  return { createAdapters };
}

export async function loadActiveRunOwnerPort() {
  const { assertActiveRunOwner, assertConnectedActiveRunOwner } = await import("../../db/repositories/active-runs.js");
  return { assertActiveRunOwner, assertConnectedActiveRunOwner };
}

export async function loadRepositoryDiscoveryPort() {
  const repositoryDiscovery = await import("../repository-discovery/runner.js");
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
  const runTelemetry = await import("../../db/repositories/runs/telemetry.js");
  return {
    get markRunFailedOnSelfMove() {
      return runTelemetry.markRunFailedOnSelfMove;
    },
    get markConnectedRunFailedOnSelfMove() {
      return runTelemetry.markConnectedRunFailedOnSelfMove;
    },
    get markRunSucceededOnSelfMove() {
      return runTelemetry.markRunSucceededOnSelfMove;
    },
    get markConnectedRunSucceededOnSelfMove() {
      return runTelemetry.markConnectedRunSucceededOnSelfMove;
    },
    get recordBlockStatuses() {
      return runTelemetry.recordBlockStatuses;
    },
    get recordConnectedBlockStatuses() {
      return runTelemetry.recordConnectedBlockStatuses;
    },
    get recordRunStatusReason() {
      return runTelemetry.recordRunStatusReason;
    },
    get recordConnectedRunStatusReason() {
      return runTelemetry.recordConnectedRunStatusReason;
    },
    get recordRunUsage() {
      return runTelemetry.recordRunUsage;
    },
    get recordConnectedRunUsage() {
      return runTelemetry.recordConnectedRunUsage;
    },
  };
}

export async function loadTicketTransitionPort() {
  const { moveTicketForRun } = await import("../support/ticket-transition.js");
  return { moveTicketForRun };
}

export async function loadVcsRuntimePort() {
  const vcsRuntime = await import("../support/vcs-runtime.js");
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
