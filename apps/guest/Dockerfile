# The guest web image. Built from the repo root: docker build -f apps/guest/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/guest/package.json apps/guest/
RUN pnpm install --frozen-lockfile --filter @west4/guest...
COPY packages/shared packages/shared
COPY apps/guest apps/guest
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec tsc -b packages/shared && pnpm --filter @west4/guest build

FROM node:22-alpine
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3001 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build /repo/apps/guest/.next/standalone /app
COPY --from=build /repo/apps/guest/.next/static /app/apps/guest/.next/static
USER node
EXPOSE 3001
CMD ["node", "apps/guest/server.js"]
