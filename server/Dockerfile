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
RUN npm run build:contracts && npm run build:server

FROM node:24-slim AS runtime
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/contracts/cube-nft/deployments ./contracts/cube-nft/deployments
COPY --from=build /workspace/contracts/cube-nft/package.json ./contracts/cube-nft/package.json
COPY --from=build /workspace/server/dist ./server/dist
COPY --from=build /workspace/server/package.json ./server/package.json
EXPOSE 3000
CMD ["node", "server/dist/main.js"]
