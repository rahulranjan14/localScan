# One image, two entry points: the server and the worker run the same build.
#
# bookworm rather than alpine, deliberately: sharp and @hyzyla/pdfium ship
# prebuilt binaries against glibc, and on musl they fall back to a source build
# that needs a toolchain this image would otherwise not carry.
FROM node:20.19-bookworm-slim

WORKDIR /app

# Manifests first, so editing source does not invalidate the dependency layer.
# The workspace layout makes every package.json part of that cache key.
COPY package.json package-lock.json ./
COPY packages/shared/package.json  packages/shared/
COPY packages/core/package.json    packages/core/
COPY packages/server/package.json  packages/server/
COPY packages/worker/package.json  packages/worker/
COPY packages/web/package.json     packages/web/
COPY packages/eval/package.json    packages/eval/
RUN npm ci

COPY . .

# Built here rather than at start, so a container that boots is one that
# compiled. This also produces packages/web/dist, which the server serves.
RUN npm run build

# Nothing here needs root. The node user ships with the image and owns the
# writeable paths it will touch.
RUN mkdir -p /app/data/files && chown -R node:node /app/data
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

# Reports unhealthy while Temporal has no worker polling, which is the state
# where uploads are accepted and never run.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]
