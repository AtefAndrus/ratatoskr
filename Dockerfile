# 依存の取得はシェルが要るので slim で行い、実行は同じ版の distroless で行う。
# distroless はシェル、apt、perl などを持たず、bun が読み込む libc 以外の Debian パッケージの脆弱性を抱えない。
FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS install
RUN mkdir -p /temp/prod /temp/data
# .npmrc も渡す。bun.lock は取得元を持たないので、これが無いと本番イメージだけが既定レジストリから取得する
COPY package.json bun.lock .npmrc /temp/prod/
# --ignore-scripts: prepare (lefthook install) は開発用で、本番イメージでは不要かつ devDependency 不在で失敗する
RUN cd /temp/prod && bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.5-distroless@sha256:3a210956422ad81cf7532e1fc1f2eb9275d6ef4c2337a9d25d530f798e80726a AS release
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
# distroless は SSL_CERT_FILE に Debian の CA 束を設定し、Bun はそこにある証明書を内蔵のルート証明書に足して信頼する。
# 信頼するルートを Bun が内蔵する NSS の版にとどめるため、空にして読ませない。
# slim は /etc/ssl/certs のハッシュ名のファイル経由で Debian のルートも信頼していたが、distroless にはそのファイルが無い
ENV SSL_CERT_FILE=

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

USER 1000:1000

# distroless の ENTRYPOINT は bun なので、CMD の bun と重ならないよう空にする
ENTRYPOINT []
CMD ["bun", "run", "src/index.ts"]
