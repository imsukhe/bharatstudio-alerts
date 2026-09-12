# The API is built from the workspace root:
#   docker build -f apps/api/Dockerfile -t alerts-api:local .
# Keep dependency installation and the runtime image separate so TypeScript,
# tests and source files do not become production runtime dependencies.
FROM node:22.17.0-alpine3.22@sha256:fc3e945f920b7e3000cd1af86c4ae406ec70c72f328b667baf0f3a8910d69eed AS build

RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @bharatstudio/alerts-api...

COPY apps/api apps/api
RUN pnpm --filter @bharatstudio/alerts-api build
RUN pnpm --filter @bharatstudio/alerts-api deploy --legacy --prod /runtime

FROM node:22.17.0-alpine3.22@sha256:fc3e945f920b7e3000cd1af86c4ae406ec70c72f328b667baf0f3a8910d69eed AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./

USER node
EXPOSE 4100
CMD ["node", "dist/src/index.js"]
