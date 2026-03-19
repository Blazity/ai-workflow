FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/api/package.json packages/api/tsconfig.json packages/api/
RUN pnpm install --frozen-lockfile
COPY packages/shared/src packages/shared/src
COPY packages/api/src packages/api/src
RUN pnpm -r build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/package.json packages/api/
COPY --from=build /app/packages/api/dist packages/api/dist
RUN pnpm install --frozen-lockfile --prod
EXPOSE 3000
CMD ["node", "packages/api/dist/index.js"]
