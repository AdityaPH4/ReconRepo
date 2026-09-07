# Built from the repo root: `docker build -f apps/api/Dockerfile .`
# (needs the whole workspace — `packages/*` compile before this app does).

FROM node:22-alpine AS build
WORKDIR /app

# package.json files only, first — the `npm ci` layer only invalidates when
# a dependency actually changes, not on every source edit.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/recon-core/package.json packages/recon-core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/mpr-core/package.json packages/mpr-core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY packages packages
COPY apps/api apps/api
RUN npm run build:packages && npm run build --workspace @toit/api
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api

EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
