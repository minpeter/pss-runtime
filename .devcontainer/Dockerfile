# Pinned base image: Node 24.x on Debian bookworm slim (digest-pinned).
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

# Pin pnpm to the repository's packageManager release so the container's
# default toolchain matches the committed lockfile.
RUN corepack enable \
  && corepack prepare pnpm@11.9.0 --activate
