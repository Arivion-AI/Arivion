FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --filter web... --prod=false --frozen-lockfile=false
COPY apps/web ./apps/web
CMD ["pnpm", "--filter", "web", "start"]
