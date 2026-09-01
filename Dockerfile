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
# --prod=false: tsx (the TypeScript runner) is a devDependency and must be in the image
RUN pnpm install --frozen-lockfile --prod=false

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000
# No VOLUME directive (Railway rejects it). Attach a volume from the platform;
# the server stores its SQLite file under RAILWAY_VOLUME_MOUNT_PATH when that is
# set, or wherever NAKA_DB points (Fly/Render configs set it to /data/naka.db).

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start Node directly on the server entry point, no pnpm/corepack in the
# runtime path. serve.ts seeds the demo merchant on an empty database, so a
# first boot with an empty volume comes up with a working shop and a console.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/server/src/serve.ts"]
