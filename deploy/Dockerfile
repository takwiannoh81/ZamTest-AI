# One Dockerfile, several targets:
#   orchestrator  - the API (Portal/Designer backend, agent endpoints)
#   web           - Caddy serving the website, Portal and Designer with automatic HTTPS
#   agent         - a cloud bot agent with Playwright browsers

ARG NODE_VERSION=22
ARG PLAYWRIGHT_VERSION=1.63.0

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CI=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- orchestrator
FROM base AS orchestrator
ENV NODE_ENV=production ZAMTEST_HOST=0.0.0.0 ZAMTEST_PORT=4000 ZAMTEST_DATA_DIR=/data
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "apps/orchestrator/src/index.ts"]

# ------------------------------------------------------------------ web build
FROM base AS web-build
ARG SITE_DOMAIN=zamtechai.com
ENV VITE_PORTAL_URL=https://portal.${SITE_DOMAIN} VITE_DESIGNER_URL=https://designer.${SITE_DOMAIN}
RUN pnpm --filter @zamtest/website --filter @zamtest/portal --filter @zamtest/designer build

FROM caddy:2 AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/website/dist /srv/website
COPY --from=web-build /app/apps/portal/dist /srv/portal
COPY --from=web-build /app/apps/designer/dist /srv/designer

# ----------------------------------------------------------------------- agent
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS agent
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CI=1 NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["node_modules/.bin/tsx", "apps/agent/src/cli.ts", "connect"]
