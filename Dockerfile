# ─────────────────────────────────────────────────────────────────────────────
# Build stage — install all deps and produce the compiled server (dist/) and the
# Vite-bundled SPA (dist-web/). This stage is discarded; only its output ships.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

# Corporate TLS-intercepting proxies (see also npm strict-ssl below). Also skip
# the ~200MB Electron binary the electron devDep would otherwise download — it's
# not needed to build the SPA or the server.
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json* ./
COPY patches/ ./patches/
RUN npm config set strict-ssl false && npm install

COPY . .
# tsc -> dist/ (compiled server, run directly below), vite -> dist-web/ (SPA).
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Runtime stage — production deps + compiled output only. Node and Git come from
# the image (node:24-slim + git installed below), matching the "containers use
# image-provided node/git" model — the desktop app bundles its own instead.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y git iproute2 procps net-tools vim cron curl ca-certificates unzip zip \
    && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# TLS certificate verification for the running server is now an admin-controlled,
# persisted setting (Settings → Network), defaulting to ENABLED and applied at
# startup by src/tls-config.ts. It is deliberately NOT hard-disabled here so the
# image ships secure-by-default; an admin behind a TLS-intercepting proxy can
# turn it off in the UI. The npm install below still needs to tolerate the proxy,
# so it sets NODE_TLS_REJECT_UNAUTHORIZED for that single command only.
COPY package.json package-lock.json* ./
COPY patches/ ./patches/
# NODE_ENV must be set before this install: the patch-package postinstall skips
# missing dev-only patch targets (app-builder-lib) only in production mode.
ENV NODE_ENV=production
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npm config set strict-ssl false && NODE_TLS_REJECT_UNAUTHORIZED=0 npm install --omit=dev

COPY app-config.json ./
# default-bootstrap.ts seeds admin/{skills,app-templates,systemprompt} from this
# tree on first run. Without it the container boots with no templates, no system
# prompt, and only bundled skills.
COPY defaults/ ./defaults/
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-web ./dist-web

EXPOSE 3000

ENV WORKSPACES_ROOT=/mnt/storage

# server.ts self-defines __dirname and auto-starts when VCA_PACKAGED != "1"
# (the container case), so the compiled entrypoint runs directly under node.
CMD ["sh", "-c", "service cron start && node dist/server.js"]
