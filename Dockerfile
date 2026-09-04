# Single-stage build. This app is a long-running Node process with a writable
# SQLite file — NOT a serverless target. On Vercel-style hosts the read-only
# filesystem breaks SQLite and cold starts break the in-process polling engine,
# which learns volatility over time. Anything that gives you a container and a
# persistent volume (Railway, Render, Fly) is the right shape.

FROM node:22-bookworm-slim

# better-sqlite3 is a native module. Prebuilds normally cover this platform,
# but the toolchain is here so a fallback source build can succeed rather than
# failing the deploy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code-only change doesn't reinstall everything.
# `postinstall` runs `prisma generate`, which needs the schema present.
COPY package.json package-lock.json prisma7.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY . .

# The build inlines NEXT_PUBLIC_* values and needs a resolvable DATABASE_URL,
# though it never opens the database. The real one is injected at runtime.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="file:/data/dev.db"
RUN npm run build

# Where the SQLite file lives. Mount a persistent volume here or every restart
# wipes the watchlists.
VOLUME ["/data"]

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
