FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src src
COPY web web
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PITFALL_HUB_DB=/data/pitfalls.db
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY bin bin
RUN ln -s /app/bin/pitfall.js /usr/local/bin/pitfall \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4477
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:4477/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "bin/pitfall.js", "serve", "--host", "0.0.0.0", "--port", "4477"]
