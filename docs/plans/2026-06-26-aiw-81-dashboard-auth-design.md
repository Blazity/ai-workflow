# AIW-81 dashboard authentication design

**Date:** 2026-06-26  
**Status:** Approved design  
**Branch/worktree:** `dashboard-auth` at `.worktrees/dashboard-auth`

## Goal

Land dashboard authentication with password reset, password invites, Google
Workspace-compatible SSO, and a minimal Users admin surface.

This extends the existing `dashboard-auth` branch. That branch already adds
Better Auth email/password login, logout, dashboard route protection, worker
session gating, and the dashboard-owned `ba_session` cookie. AIW-81 finishes the
remaining scope: password reset, invites, SSO, role-limited user management, and
designer-ready UI coverage.

## Non-goals

- No multi-tenant product model.
- No organization switcher, organization settings UI, teams, or tenant picker.
- No public sign-up.
- No owner transfer.
- No user removal/disable/offboarding flow.
- No account/profile menu.
- No user-facing audit log.
- No search/filter in the Users page.

## Architecture

The worker remains the auth authority. The dashboard remains a BFF: browser
requests hit the dashboard origin, and the dashboard stores the worker session
token in its first-party `ba_session` httpOnly cookie. Dashboard server routes
replay that token to the worker as `Authorization: Bearer <token>`.

Use Better Auth organization support internally, but keep the product
single-tenant:

- Seed one fixed organization, for example `AI Workflow`.
- Disable user-created organizations.
- Every user belongs to the fixed organization.
- Do not expose organization switching or organization configuration.
- Use organization membership, invitations, and roles as internal auth
  primitives only.

The current branch has `better-auth` installed but does not use the organization
plugin yet. It also does not include the SSO package; AIW-81 should add
`@better-auth/sso` if the final implementation uses Better Auth's SSO plugin.

## Roles

Roles are fixed to `owner`, `admin`, and `member`.

- `owner`: the seeded initial user. Can invite users, resend/cancel invites, and
  promote/demote `member`/`admin`.
- `admin`: can invite users and resend/cancel pending invites.
- `member`: can use the dashboard but has no user-management permissions.

Additional constraints:

- The seeded owner is fixed.
- No owner transfer.
- Owner cannot demote or change themselves.
- Admins cannot promote, demote, or create admins indirectly.
- All invites create `member`; owner may promote accepted members later.
- Better Auth's default organization `admin` role is broader than this design,
  so implementation should define a narrower admin permission set.

## SSO

SSO is optional by configuration. If SSO env vars are absent, the app remains
password-only and the login screen hides SSO.

When configured, SSO should be provider-neutral in UI:

- Login button text is always `Continue with SSO`.
- Do not add a provider display-name env var.
- Product UI should not hard-code Google Workspace, though setup docs can
  document Google Workspace OIDC as the validated first configuration.

For Google Workspace/OIDC:

- Configure the provider for the Workspace/org where possible.
- Treat the app-side domain check as the real security boundary.
- Validate the returned provider claim, such as Google's `hd`, against the
  configured allowed domain.
- SSO users with a valid allowed-domain login auto-join the fixed org as
  `member`.
- SSO users outside the allowed domain are redirected back to login with generic
  SSO-not-allowed copy.

Account linking:

- Existing password user signing in with SSO using the same verified email
  should link the SSO account and sign in.
- Do not allow different-email linking.
- SSO-only users cannot set a password through reset.
- Password login remains allowed for seeded/invited password users even if their
  email is outside the SSO domain.
- Workspace-domain users can still be invited and use password if invited.
- Do not expose unlinking in AIW-81.

The SSO redirect flow must end with a dashboard-owned cookie. Because the worker
is the auth authority but the dashboard owns `ba_session`, SSO must hand off to
a dashboard callback/complete route that sets the dashboard cookie. Do not rely
on worker-domain cookies for dashboard access.

## Password Auth

Email/password sign-up stays disabled.

Password-capable users are:

- Seeded owner.
- Invited users who accepted an invite and created a password.
- Password users who later linked SSO.

Password reset:

- Reset applies only to users who already have a credential/password account.
- SSO-only users recover through their IdP.
- Reset request response is always generic to avoid account enumeration.
- Reset never creates a credential account for an SSO-only user.
- Reset/setup screens require password and confirm password.
- Password policy is minimum 8 characters, no complexity requirements.

## Invites

Invites are for password onboarding. They may target any email domain.

- All invites create `member`.
- Invite email link is the ownership proof.
- No additional email verification step unless Better Auth requires it.
- Invite links are single-use and use Better Auth's default 48-hour expiry.
- Owner/admin can resend or cancel any pending invite.
- Pending invites are visible to owner/admin.
- Accepted invite links cannot be reused.

All user-facing invite links land on dashboard pages first. Dashboard API routes
proxy to the worker. The browser should not need to know the worker origin.

## Users UI Designer Brief

Route: `/users`  
Sidebar/mobile label: `Users`

Visibility:

- Visible to owner/admin only.
- Hidden from members in desktop sidebar and mobile navigation.
- Signed-in member direct access renders a 403-style page.
- Users/Invites APIs return 403 for unauthorized roles.

Screens and states needed:

- Login
  - Primary `Continue with SSO` when SSO is configured.
  - Visible email/password form below SSO.
  - Forgot password link.
  - Invalid credentials and generic SSO-not-allowed errors.
- Forgot password
  - Email input.
  - Generic success state.
- Reset password
  - Password and confirm password.
  - Expired/invalid token state.
- Accept invite
  - Invited email and product/org context.
  - Create password and confirm password.
  - Expired/canceled/already-accepted states.
- Users page
  - Two tabs: `Members` and `Invites`.
  - No current-user role banner.
  - No search/filter.
- 403 not authorized
  - Simple blocked-access state with a return-to-dashboard action.

Members tab:

- Columns: Name, Email, Role, Auth method, Joined, Actions.
- Auth method values: `Password`, `SSO`, `Password + SSO`.
- Owner can promote member to admin and demote admin to member.
- Owner role has no role-change action.
- Admin/member rows do not expose actions to admins except ordinary invite
  management on the Invites tab.

Invites tab:

- Columns: Email, Invited by, Status/Expiry, Sent, Actions.
- Invite form/modal asks for email only.
- Role is always member and should not be a field.
- Actions: resend and cancel.
- Bounced/failed invite email shows as `Email failed` with resend/cancel.

## Worker API Shape

Do not call generic Better Auth organization endpoints directly from the
dashboard UI. Add dedicated dashboard-facing worker endpoints under `/api/v1`,
gated by session and role:

- `GET /api/v1/users`
- `PATCH /api/v1/users/:id/role`
- `GET /api/v1/invites`
- `POST /api/v1/invites`
- `POST /api/v1/invites/:id/resend`
- `POST /api/v1/invites/:id/cancel`

These endpoints enforce:

- Fixed single organization.
- Owner/admin/member role permissions.
- Member-only invites.
- Owner-only role changes.
- Stable UI-shaped response data.

## Email

Use Resend first, behind a small `sendEmail()` wrapper so another provider can
replace it later.

Email templates:

- Simple branded HTML plus plain-text fallback.
- Invite email includes CTA, expiry, and fallback URL.
- Reset email includes CTA and fallback URL.

Invite delivery:

- If Resend rejects synchronously, do not create the invite.
- If Resend accepts the send request, create the pending invite and store the
  Resend email id.
- A signature-verified Resend webhook updates invite email status on bounce or
  failure.
- Bounced invite remains pending until canceled or expired, and shows `Email
  failed` with resend/cancel.

Password reset delivery:

- Uses Resend.
- No visible delivery status.
- Only synchronous failures/logging are needed.

Webhook security:

- Add `RESEND_WEBHOOK_SECRET`.
- Reject unauthenticated or unverifiable webhook writes.

## Error Handling

- Missing session on dashboard routes redirects to `/login`.
- Invalid or unverifiable session fails closed.
- Invalid password login shows generic invalid credentials.
- Forgot password always shows generic success.
- Reset for SSO-only user does not create a credential and does not reveal
  account state.
- SSO wrong domain/provider redirects to login with generic SSO-not-allowed
  copy.
- `/users` direct member access renders 403.
- Users/Invites APIs return 403.
- SSO not configured hides the SSO button and leaves password auth working.
- Resend accepted then bounces marks the invite row as `Email failed`.

## Observability

Add minimal structured logs, not a user-facing audit log.

Log:

- Invite created, resent, canceled.
- Invite email bounced/failed.
- Role changed.
- SSO auto-join.
- SSO domain rejection.
- Permission-denied attempts on Users/Invites APIs.

Include actor/user ids where available. Durable audit tables and UI are out of
scope.

## Testing

Worker tests:

- Bootstrap seeds owner, fixed org, owner membership, and SSO provider config
  when enabled.
- SSO domain acceptance/rejection.
- Existing password user can link/sign in via SSO with the same verified email.
- Different-email SSO linking is rejected.
- SSO-only users cannot gain credential access through reset.
- Role gates for owner/admin/member.
- Invite create/resend/cancel.
- Invites are member-only.
- Resend synchronous failure does not create an invite.
- Resend webhook signature verification and invite status update.
- Users/Invites endpoints return 403 for members.

Dashboard verification:

- Login states with and without SSO configured.
- Forgot/reset/accept-invite screens and validation.
- `/users` visible to owner/admin and hidden from members.
- Member direct access renders 403.
- Members and Invites tabs render required columns/states.
- Logout/session behavior remains intact.

Baseline:

- `pnpm -r test` must pass.

## Resolved Decisions

- Use single fixed organization internally; no multi-tenant UX.
- Use Better Auth organization primitives if they fit the implementation.
- Use Google Workspace-compatible OIDC as the validated SSO setup path.
- Keep UI provider-neutral as `SSO`.
- SSO is optional by env.
- Password access remains invite/seed only.
- Existing password users can link SSO by same verified email.
- SSO-only users cannot create passwords through reset.
- Users page is named `Users`, not `Access`.
- Users has Members and Invites tabs.
- No search/filter.
- No profile/account menu.
- No user removal/disable.
- Minimal structured logs only.
