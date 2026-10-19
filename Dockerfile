FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS base
WORKDIR /app

# 依存だけを先に入れてレイヤーキャッシュを効かせる
FROM base AS install
RUN mkdir -p /temp/prod
# .npmrc も渡す。bun.lock は取得元を持たないので、これが無いと本番イメージだけが既定レジストリから取得する
COPY package.json bun.lock .npmrc /temp/prod/
# --ignore-scripts: prepare (lefthook install) は開発用で、本番イメージでは不要かつ devDependency 不在で失敗する
RUN cd /temp/prod && bun install --frozen-lockfile --production --ignore-scripts

FROM base AS release
COPY --from=install --chown=bun:bun /temp/prod/node_modules node_modules
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun package.json .

# SQLite の置き場。Coolify の永続ボリュームをここへマウントする
RUN mkdir -p /app/data && chown -R bun:bun /app/data

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/ratatoskr.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER bun

CMD ["bun", "run", "src/index.ts"]
