# Build context is the repository root (see ../docker-compose.yml), because this is an npm
# workspaces monorepo and the server workspace depends on the sibling @cube-nft/contracts package.
FROM node:24-slim AS base
WORKDIR /workspace

FROM base AS deps
COPY package.json package-lock.json ./
COPY contracts/cube-nft/package.json contracts/cube-nft/package.json
COPY server/package.json server/package.json
RUN npm ci

FROM deps AS build
COPY . .
# Bound the compiler heap so the build also succeeds on small Docker VMs (a 2 GB Docker Desktop VM
# OOM-killed an unbounded `nest build` with exit 137); the two builds run as separate processes.
ENV NODE_OPTIONS=--max-old-space-size=1280
RUN npm run build:contracts
RUN npm run build:server

# Production-only dependency tree for the runtime image: no Hardhat/Mocha/Jest/ESLint toolchain
# (which is where the audit's `high` finding lives) ships to production.
FROM build AS prod-deps
RUN npm prune --omit=dev

FROM node:24-slim AS runtime
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=prod-deps /workspace/node_modules ./node_modules
# Deployment artifacts live in `contracts/deployments/` (written by contracts/cube-nft/scripts/deploy.ts,
# read by server/src/shared/config/contract-deployment.loader.ts via `@cube-nft/contracts/../deployments`).
COPY --from=build /workspace/contracts/deployments ./contracts/deployments
COPY --from=build /workspace/contracts/cube-nft/package.json ./contracts/cube-nft/package.json
COPY --from=build /workspace/server/dist ./server/dist
COPY --from=build /workspace/server/package.json ./server/package.json
COPY --from=build /workspace/package.json ./package.json
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/main.js"]
