FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/worker/package.json packages/worker/tsconfig.json packages/worker/
RUN pnpm install --frozen-lockfile
COPY packages/shared/src packages/shared/src
COPY packages/worker/src packages/worker/src
COPY packages/worker/prompts packages/worker/prompts
RUN pnpm -r build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/worker/package.json packages/worker/
COPY --from=build /app/packages/worker/dist packages/worker/dist
COPY --from=build /app/packages/worker/prompts packages/worker/prompts
RUN pnpm install --frozen-lockfile --prod
CMD ["node", "packages/worker/dist/index.js"]
