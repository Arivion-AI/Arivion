FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/package.json
RUN pnpm install --filter agent... --prod=false --frozen-lockfile=false
COPY apps/agent ./apps/agent
CMD ["sh", "-c", "pnpm --filter agent start"]
