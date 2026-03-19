FROM node:20-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/app/package.json packages/app/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/app/ packages/app/
RUN pnpm --filter @blazebot/shared build
RUN pnpm --filter @blazebot/app build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/packages/app/.output .output
COPY --from=build /app/packages/app/prompts prompts

ENV PORT=3000
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
