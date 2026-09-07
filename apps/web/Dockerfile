# Built from the repo root: `docker build -f apps/web/Dockerfile .`

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/recon-core/package.json packages/recon-core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/mpr-core/package.json packages/mpr-core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY packages packages
COPY apps/web apps/web
# NEXT_PUBLIC_* vars are baked in at build time — pass with
# `--build-arg NEXT_PUBLIC_API_URL=https://...`.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build:packages && npm run build --workspace @toit/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# `output: 'standalone'` (next.config.mjs) traces only the files this app
# actually needs — no full node_modules copy required.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
