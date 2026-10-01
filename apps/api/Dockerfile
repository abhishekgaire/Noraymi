# The API image. Built from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/rules/package.json packages/rules/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @west4/api...
COPY packages/shared packages/shared
COPY packages/rules packages/rules
COPY packages/db packages/db
COPY seed packages/db/seed
COPY apps/api apps/api
RUN pnpm exec tsc -b apps/api \
  && pnpm --filter @west4/api deploy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
# The runtime needs Node only. npm and corepack (and their bundled dependencies)
# stay out of the image so the container scan checks what actually runs.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# The menu PDF job (M3-05) prints HTML with the system Chromium; Noto covers the menu's accents.
RUN apk add --no-cache chromium font-noto
ENV MENU_PDF_CHROMIUM=/usr/bin/chromium
COPY --from=build /out /app
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
