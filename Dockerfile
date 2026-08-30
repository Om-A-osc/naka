# Naka, one container, one merchant server (with any number of onboarded
# tenants inside it). SQLite lives on a mounted volume at /data.
#
# Build context is the repository root (see .dockerignore for what is left out).
FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries for this platform; the toolchain is
# only a fallback if a prebuilt is ever missing for the node version in use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production \
    NAKA_DB=/data/naka.db \
    PORT=3000
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# serve.ts seeds the demo merchant on an empty database, so a first boot
# with an empty volume comes up with a working shop and a console.
CMD ["pnpm", "server"]
