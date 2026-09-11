import { sso } from "@better-auth/sso";
import { oauthProvider, type OAuthOptions } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import {
  bearer,
  jwt,
  oneTimeToken,
  organization as organizationPlugin,
} from "better-auth/plugins";
import { defaultAc } from "better-auth/plugins/organization/access";

import {
  createAuthDatabaseAdapter,
  handleResetPasswordRequest,
  type AuthDatabase,
  type AuthOptions,
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
  const passwordReset = options.passwordReset;
  const mcpDeployment = options.mcp
    ? { ...options.mcp, baseURL: options.baseURL, db }
    : null;

  return betterAuth({
    database: createAuthDatabaseAdapter(db),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      sendResetPassword: passwordReset
        ? ({ user, token }) =>
            handleResetPasswordRequest(db, passwordReset, { user, token })
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
            await validateMcpOAuthHookRequest(
              mcpDeployment,
              ctx.path,
              ctx.body as Record<string, unknown> | undefined,
              ctx.request?.headers.get("authorization"),
            );
          }),
        }
      : undefined,
    plugins: [
      bearer(),
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
