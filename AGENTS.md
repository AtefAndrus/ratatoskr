# ratatoskr

監視対象の X アカウントの投稿 URL を Discord チャンネルへ中継する Bot。

## Repository

- GitHub: [AtefAndrus/ratatoskr](https://github.com/AtefAndrus/ratatoskr)

## Documentation

| Document | Role |
| -------- | ---- |
| [README.md](README.md) | 概要、コマンド、環境変数、セットアップ |
| [docs/deployment.md](docs/deployment.md) | Coolify へのデプロイ手順 |
| [docs/admin-api.md](docs/admin-api.md) | 管理 API の仕様と署名手順 |

## Tech Stack

- Runtime: Bun 1.4 (`mise.toml` が SSOT で、Dockerfile の base image と bun-types を同じ patch に揃える。CI の drift-check が不一致を落とす)
- Language: TypeScript (ESNext, strict, `verbatimModuleSyntax`)
- Discord: discord.js v14
- Database: SQLite (`bun:sqlite`, WAL)
- Linter / Formatter: oxlint (type-aware, `oxlint-tsgolint`) / oxfmt
- Config validation: zod

## Directory Structure

```text
src/
├── index.ts               # エントリポイントと DI
├── cli.ts                 # 受信アカウント管理 CLI
├── config/                # 環境変数の読み込みと検証
├── bot/                   # Discord クライアント、Slash Command、イベント
├── db/
│   ├── index.ts           # 接続とマイグレーション適用
│   ├── schema.ts          # スキーマ (バージョン番号付きマイグレーション)
│   └── repositories/      # テーブルごとのデータアクセス
├── services/
│   ├── receiverSupervisor.ts  # 受信アカウントごとの AutoPush 受信と内部 GraphQL 収集の監督
│   ├── watchService.ts        # /watch の実体
│   └── deliveryService.ts     # 経路単位の重複排除と Discord 送信
├── pipeline/
│   ├── webpushPipeline.ts       # 生フレーム保存 → 復号 → 解析 → 配信
│   └── internalPollCollector.ts # 適応ポーリングと新規投稿の配信
├── autopush/              # Mozilla AutoPush プロトコルと WebSocket クライアント
├── webpush/               # RFC 8291 aes128gcm と旧 aesgcm の復号、鍵生成
├── x/                     # X の非公開 API (Push 登録、フォロー設定、内部 GraphQL、transaction ID)
├── notification/          # X 通知ペイロードの解析
├── http/                  # /health と HMAC 認証付き /admin/*
├── maintenance/           # 保持期間の適用
└── utils/                 # logger, metrics, base64url, hidden input
tests/                     # bun:test。DB は :memory:、fetch は関数注入で差し替える
```

## Commands

```bash
bun dev              # 開発起動
bun start            # 本番起動
bun run cli          # CLI の使い方を表示
bun run check        # format:check, lint, typecheck, test, lint:md
bun run format       # oxfmt
bun run lint:fix     # oxlint --fix
bun test
```

## Coding Conventions

- ファイル名は camelCase、クラスは PascalCase、定数は UPPER_SNAKE_CASE。
- 型だけの import は `import type` を使う。
- 関数には戻り値の型を明示する。
- `any` を使わない。外部 JSON は `unknown` で受けて型ガードで絞る。
- コードコメントは「なぜそうしないか」を書く。何をしているかはコードで示す。
- 秘密情報 (X の Cookie、Discord Token、Web Push 秘密鍵) をログ、コマンド引数、テスト fixture に書かない。

## Testing

- Framework: bun:test
- DB は `openDatabase(":memory:")` を使う。
- 外部 HTTP は `fetchImplementation` 引数でモックする。
- Discord 送信は `DiscordPostSender` インターフェースの偽実装を使う。

## Git

- Commit messages: 日本語または英語。形式は `[type] short description`。
- Branch: `main` への直接コミットは lefthook が止める。
- Release: `package.json` の version を上げ、`bun run changelog` で CHANGELOG.md を生成し、タグを打って GitHub Release を公開すると Coolify へデプロイされる。

## Notes

- X 側の仕様が変わったときは `/admin/exchanges` と `/admin/observations?errors=1` で生応答を確認する。
- 内部 GraphQL の query ID と feature 一覧は起動時と 6 時間ごとに fa0311/TwitterInternalAPIDocument から取得する。
- Discord への送信は `delivery_claims` の `(route_id, dedupe_key)` 一意制約で重複排除する。この表は保持期間で消さない。
