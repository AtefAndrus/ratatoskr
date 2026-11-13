# 依存の取得はシェルが要るので slim で行い、実行は同じ版の distroless で行う。
# distroless はシェル、apt、perl などを持たず、bun が読み込む libc 以外の Debian パッケージの脆弱性を抱えない。
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS install
RUN mkdir -p /temp/prod /temp/data
# .npmrc も渡す。bun.lock は取得元を持たないので、これが無いと本番イメージだけが既定レジストリから取得する
COPY package.json bun.lock .npmrc /temp/prod/
# --ignore-scripts: prepare (lefthook install) は開発用で、本番イメージでは不要かつ devDependency 不在で失敗する
RUN cd /temp/prod && bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470 AS release
WORKDIR /app
# distroless には bun ユーザーが無いので、slim の bun ユーザーと同じ 1000:1000 を数値で指定する。
# 本番の Pod も runAsUser / fsGroup に 1000 を指定している
COPY --from=install --chown=1000:1000 /temp/prod/node_modules node_modules
COPY --chown=1000:1000 src ./src
COPY --chown=1000:1000 package.json .
# SQLite の置き場。永続ボリューム (本番では PersistentVolumeClaim) をここへマウントする。
# シェルが無く mkdir できないため、install で作った空ディレクトリを所有者付きで写す
COPY --from=install --chown=1000:1000 /temp/data /app/data

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/ratatoskr.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

USER 1000:1000

# distroless の ENTRYPOINT は bun なので、CMD の bun と重ならないよう空にする
ENTRYPOINT []
CMD ["bun", "run", "src/index.ts"]
