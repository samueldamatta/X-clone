# syntax=docker/dockerfile:1
#
# Build context is the repository root, not this directory — see the `context:`
# key in infra/docker/compose.yml. A package in a pnpm workspace cannot be
# installed on its own: the lockfile and the manifests of every package it
# links to live above it.

# Same base as the Identity service. Nothing here needs glibc specifically —
# the Gateway has no native dependency — but two services on two different
# libc implementations is a difference that only ever pays off as a surprise.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo

# Manifests before sources, deliberately. This layer's cache key is the
# lockfile and the package.json files, so editing a controller does not
# reinstall node_modules — only changing a dependency does.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY backend/gateway/package.json backend/gateway/
COPY backend/libs/problem-details/package.json backend/libs/problem-details/
COPY backend/libs/proto/package.json backend/libs/proto/
RUN pnpm install --filter @x-clone/gateway... --frozen-lockfile

COPY backend backend
# `pkg...` builds pkg *and everything it depends on*, in topological order —
# @x-clone/proto compiles (and copies identity.proto into its dist) before the
# Gateway, which resolves the file's path out of that dist at runtime.
RUN pnpm --filter @x-clone/gateway... build

# `deploy` writes a self-contained directory: this package's own files plus a
# node_modules where each workspace dependency has been copied in, rather than
# symlinked back out to a store that will not exist in the runtime image.
RUN pnpm --filter @x-clone/gateway --prod deploy --legacy /app

FROM base AS runtime
WORKDIR /app

# node:* images ship an unprivileged `node` user. Running as root inside a
# container is not a sandbox escape by itself, but it removes the last barrier
# if one is ever found.
COPY --from=build --chown=node:node /app ./
USER node

ENV NODE_ENV=production
# The only port in this system a browser ever connects to.
EXPOSE 8080

CMD ["node", "dist/main.js"]
