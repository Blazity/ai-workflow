import { sso } from "@better-auth/sso";
import { oauthProvider, type OAuthOptions } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import {
  bearer,
  jwt,
  oneTimeToken,
  organization as organizationPlugin,
} from "better-auth/plugins";
import { defaultAc } from "better-auth/plugins/organization/access";

import {
  createAuthPersistence,
  createConnectedAuthPersistence,
  handleResetPasswordRequest,
  type AuthDatabase,
  type AuthOptions,
  type AuthPersistence,
} from "./services/auth/auth-core.js";
import {
  createMcpOAuthOptions,
  validateMcpOAuthHookRequest,
  type McpOAuthDeployment,
} from "./services/auth/mcp-oauth-options.js";

export {
  DASHBOARD_SSO_PROVIDER_ID,
  assertSession,
  bootstrapDashboardAuth,
  seedAuthUser,
  userHasCredentialAccount,
} from "./services/auth/auth-core.js";
export type {
  AuthOptions,
} from "./services/auth/auth-core.js";

const ownerRole = defaultAc.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: [],
  ac: [],
});

const adminRole = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: ["create", "cancel"],
  team: [],
  ac: [],
});

const memberRole = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: [],
});

/** Compose Better Auth at the app tier over service-owned persistence and hooks. */
export function createAuth(db: AuthDatabase, options: AuthOptions) {
  return createAuthFromPersistence(createAuthPersistence(db), options);
}

export function createConnectedAuth(options: AuthOptions) {
  return createAuthFromPersistence(createConnectedAuthPersistence(), options);
}

function createAuthFromPersistence(
  persistence: AuthPersistence,
  options: AuthOptions,
) {
  const passwordReset = options.passwordReset;
  const mcpDeployment = options.mcp
    ? { ...options.mcp, ...persistence.mcp, baseURL: options.baseURL }
    : null;

  return betterAuth({
    database: persistence.adapter,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      sendResetPassword: passwordReset
        ? ({ user, token }) =>
            handleResetPasswordRequest(persistence.repository, passwordReset, { user, token })
        : undefined,
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        allowDifferentEmails: false,
        requireLocalEmailVerified: true,
        trustedProviders: ["workspace-sso"],
      },
    },
    hooks: mcpDeployment
      ? {
          before: createAuthMiddleware(async (ctx) => {
            if (ctx.path === "/oauth2/register") return;
            await validateMcpOAuthHookRequest(
              mcpDeployment,
              ctx.path,
              ctx.body as Record<string, unknown> | undefined,
              ctx.request?.headers.get("authorization") ??
                ctx.headers?.get("authorization"),
            );
          }),
        }
      : undefined,
    plugins: [
      bearer(),
      ...(mcpDeployment
        ? [createMcpRegistrationPolicyPlugin(mcpDeployment)]
        : []),
      oneTimeToken({
        disableClientRequest: true,
        expiresIn: 1,
        storeToken: "hashed",
      }),
      organizationPlugin({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
        invitationExpiresIn: 60 * 60 * 48,
        roles: {
          owner: ownerRole,
          admin: adminRole,
          member: memberRole,
        },
        disableOrganizationDeletion: true,
      }),
      sso({
        providersLimit: 10,
        domainVerification: { enabled: true },
        disableImplicitSignUp: false,
        trustEmailVerified: true,
        organizationProvisioning: {
          defaultRole: "member",
        },
      }),
      ...(mcpDeployment ? [jwt(), createMcpOAuthProvider(mcpDeployment)] : []),
    ],
    trustedOrigins: options.trustedOrigins,
    secret: options.secret,
    baseURL: options.baseURL,
  });
}

export type Auth = ReturnType<typeof createAuth>;

function createMcpOAuthProvider(deployment: McpOAuthDeployment) {
  return oauthProvider(createMcpOAuthOptions(deployment) as OAuthOptions<string[]>);
}

function createMcpRegistrationPolicyPlugin(deployment: McpOAuthDeployment) {
  return {
    id: "mcp-registration-policy",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(async (ctx) => {
            let session = await getSessionFromCtx(ctx);
            if (!session) {
              // Global hooks run before bearer() has converted the signed bearer
              // value into Better Auth's session cookie. Resolve that same stored
              // session here so the registration policy sees the route's actor.
              const authorization =
                ctx.request?.headers.get("authorization") ??
                ctx.headers?.get("authorization");
              const bearerValue = authorization
                ?.match(/^Bearer\s+(.+)$/iu)?.[1]
                ?.trim();
              const sessionToken = decodeBearerSessionToken(bearerValue);
              const candidate = sessionToken
                ? await ctx.context.internalAdapter.findSession(sessionToken)
                : null;
              if (candidate && candidate.session.expiresAt > new Date()) {
                session = candidate;
              }
            }
            await validateMcpOAuthHookRequest(
              deployment,
              ctx.path,
              ctx.body as Record<string, unknown> | undefined,
              undefined,
              session
                ? {
                    userId: session.user.id,
                    activeOrganizationId: session.session.activeOrganizationId,
                  }
                : undefined,
            );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

function decodeBearerSessionToken(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value.split(".", 1)[0]!);
  } catch {
    return null;
  }
}
