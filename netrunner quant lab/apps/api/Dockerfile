FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --filter api... --prod=false --frozen-lockfile=false
COPY apps/api ./apps/api
COPY packages/ui ./packages/ui
CMD ["sh", "-c", "pnpm --filter api migrate && pnpm --filter api seed && pnpm --filter api start"]
