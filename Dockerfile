# One image for web and the migrate job (and the worker from phase 1).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Workspace manifests only, so dependency layers cache across code changes.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/flow-schema/package.json packages/flow-schema/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/

FROM manifests AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM manifests AS run
ENV NODE_ENV=production PORT=3000
RUN CI=true pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/packages/flow-schema/dist packages/flow-schema/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/auth/dist packages/auth/dist
COPY --from=build /app/apps/web/.next apps/web/.next
COPY --from=build /app/apps/web/next.config.ts apps/web/
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@oicr/web", "start"]
