# One image for web, worker and the migrate job.
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
COPY packages/adapters/package.json packages/adapters/
COPY packages/engine/package.json packages/engine/
COPY packages/runtime/package.json packages/runtime/
COPY packages/ai/package.json packages/ai/
COPY packages/notify/package.json packages/notify/
COPY apps/worker/package.json apps/worker/

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
COPY --from=build /app/packages/adapters/dist packages/adapters/dist
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/runtime/dist packages/runtime/dist
COPY --from=build /app/packages/ai/dist packages/ai/dist
COPY --from=build /app/packages/notify/dist packages/notify/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/web/.next apps/web/.next
COPY --from=build /app/apps/web/next.config.ts apps/web/
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@oicr/web", "start"]
