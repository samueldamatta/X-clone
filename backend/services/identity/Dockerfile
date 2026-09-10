# syntax=docker/dockerfile:1
#
# Build context is the repository root, not this directory — see the `context:`
# key in infra/docker/compose.yml. A package in a pnpm workspace cannot be
# installed on its own: the lockfile and the manifests of every package it
# links to live above it.

# bookworm-slim rather than alpine, and the reason is argon2. It is a native
# addon, and its prebuilt binaries target glibc. On alpine (musl) there is no
# prebuild to download, so npm falls back to compiling from source — which
# means python3, make and g++ in the build image, and a first build that takes
# minutes instead of seconds. The ~40 MB alpine would have saved is not worth
# a toolchain in the image.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo

# Manifests before sources, deliberately. This layer's cache key is the
# lockfile and the package.json files, so editing a use case does not
# reinstall node_modules — only changing a dependency does.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY backend/libs/drizzle-snowflake/package.json backend/libs/drizzle-snowflake/
COPY backend/libs/problem-details/package.json backend/libs/problem-details/
COPY backend/libs/proto/package.json backend/libs/proto/
COPY backend/libs/snowflake/package.json backend/libs/snowflake/
COPY backend/services/identity/package.json backend/services/identity/
RUN pnpm install --filter @x-clone/identity... --frozen-lockfile

COPY backend backend
# `pkg...` builds pkg *and everything it depends on*, in topological order —
# the libs compile before the service that imports their dist.
RUN pnpm --filter @x-clone/identity... build

# `deploy` writes a self-contained directory: this package's own files plus a
# node_modules where each workspace dependency has been copied in, rather than
# symlinked back out to a store that will not exist in the runtime image.
# --prod drops devDependencies — drizzle-kit generates migrations, it does not
# apply them (see migrate.ts).
RUN pnpm --filter @x-clone/identity --prod deploy --legacy /app

FROM base AS runtime
WORKDIR /app

# node:* images ship an unprivileged `node` user. Running as root inside a
# container is not a sandbox escape by itself, but it removes the last barrier
# if one is ever found.
COPY --from=build --chown=node:node /app ./
USER node

ENV NODE_ENV=production
# gRPC only. Nothing public is served from this port — the Gateway is the only
# thing that dials it, over the compose network.
EXPOSE 8081

CMD ["node", "dist/main.js"]
