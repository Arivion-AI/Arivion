FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/mcp/package.json apps/mcp/package.json
RUN pnpm install --filter mcp... --prod=false --frozen-lockfile=false
COPY apps/mcp ./apps/mcp
RUN pnpm --filter mcp build
EXPOSE 8080
CMD ["sh", "-c", "node apps/mcp/dist/index.js --http"]
