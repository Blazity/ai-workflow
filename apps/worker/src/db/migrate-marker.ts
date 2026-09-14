export interface DatabaseMarker {
  env: string;
  endpointHost: string;
}

type MarkerAction = "claim" | "reclaim" | "ok" | "shared" | "fatal";

export interface MarkerDecision {
  action: MarkerAction;
  message: string;
}

export function decideMarkerAction({
  marker,
  host,
  vercelEnv,
  sharedWith,
}: {
  marker: DatabaseMarker | null;
  host: string;
  vercelEnv: string;
  sharedWith: string | undefined;
}): MarkerDecision {
  if (sharedWith !== undefined) {
    if (vercelEnv === "production") {
      return {
        action: "fatal",
        message:
          `[db-migrate] FATAL: VERCEL_ENV='production' must not set ` +
          `DATABASE_SHARED_WITH='${sharedWith}'; production never declares database sharing.`,
      };
    }

    if (marker === null) {
      return {
        action: "fatal",
        message:
          `[db-migrate] FATAL: DATABASE_SHARED_WITH='${sharedWith}' requires an existing ` +
          "env_marker owned by that environment; a shared database must already be claimed.",
      };
    }

    if (marker.endpointHost === host && marker.env === sharedWith) {
      return {
        action: "shared",
        message:
          `[db-migrate] sharing the '${sharedWith}' database by declaration ` +
          "(DATABASE_SHARED_WITH); marker left untouched.",
      };
    }

    return {
      action: "fatal",
      message:
        `[db-migrate] FATAL: VERCEL_ENV='${vercelEnv}' on host '${host}' declares ` +
        `DATABASE_SHARED_WITH='${sharedWith}', but the marker is owned by ` +
        `VERCEL_ENV='${marker.env}' on host '${marker.endpointHost}'.`,
    };
  }

  if (marker === null) {
    return {
      action: "claim",
      message: `[db-migrate] OK \u2014 branch claimed by '${vercelEnv}'.`,
    };
  }

  if (marker.endpointHost !== host) {
    return {
      action: "reclaim",
      message:
        `[db-migrate] branch copied from '${marker.env}' (${marker.endpointHost}) ` +
        `\u2014 re-claiming for '${vercelEnv}'.`,
    };
  }

  if (marker.env !== vercelEnv) {
    return {
      action: "fatal",
      message:
        `[db-migrate] FATAL: this Neon branch is already claimed by VERCEL_ENV='${marker.env}', ` +
        `but this build is VERCEL_ENV='${vercelEnv}'. Environments must not share a branch \u2014 ` +
        "enable branch-per-environment in the Neon Vercel integration (see SETUP.md \u00A74).",
    };
  }

  return {
    action: "ok",
    message: `[db-migrate] OK \u2014 branch claimed by '${vercelEnv}'.`,
  };
}
