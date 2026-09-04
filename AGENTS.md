# ratatoskr

監視対象の X アカウントの投稿 URL を Discord チャンネルへ中継する Bot。
概要と環境変数は [README.md](README.md)、デプロイは [docs/deployment.md](docs/deployment.md)、管理 API は [docs/admin-api.md](docs/admin-api.md) を参照する。

## Commands

```bash
mise run setup       # bun install と .env の作成
bun dev              # 開発起動 (.env / .env.local を読む)
bun run cli          # 受信用 X アカウント管理 CLI の使い方を表示
bun run check        # format:check, lint, typecheck, test, lint:md をまとめて実行
bun run format       # oxfmt (Markdown は対象外。markdownlint-cli2 が format:md で整形する)
bun run lint:fix     # oxlint --type-aware --fix
bun test             # bun:test
```

- 起動には `DISCORD_TOKEN` と `DISCORD_APPLICATION_ID` が要る。受信用 X アカウントは `bun run cli receiver:add <label>` で SQLite に入れる。
- 実 API に触る動作確認は、受信アカウントの Cookie と Discord Token を環境変数で渡して `bun dev` を短時間動かし、`/health` と `/admin/*` で観測する。

## Conventions that differ from defaults

- oxlint は `typeAware` で動かす。`no-await-in-loop` と `no-unsafe-type-assertion` は意図的に無効化している (再接続ループの逐次 await と `bun:sqlite` 行の型付けのため)。有効に戻さない。
- ファイル名は camelCase (`receiverSupervisor.ts`)。PoC 由来の kebab-case は使わない。
- 外部 JSON は `unknown` で受けて型ガードで絞る。`any` を使わない。
- コードコメントは「なぜそうしないか」だけを書く。
- 秘密情報 (X の Cookie、Discord Token、Web Push 秘密鍵) をログ、コマンド引数、テスト fixture、Issue や PR に書かない。CLI は非表示入力で受け取る。

## Architecture notes (コードから読み取りにくい判断)

- Discord への送信は `delivery_claims` の `(route_id, dedupe_key)` 一意制約で重複排除する。Web Push と内部 GraphQL が同じ投稿を検出しても 1 回しか送らない根拠はこの表だけなので、保持期間で消さない。
- 起動時刻より前に作成された投稿は保存だけして送らない (`deliveryNotBefore`)。AutoPush が切断中の通知を再配信してもバックログを流さないため。
- 受信用 X アカウントは全員がすべての監視対象をフォローする冗長構成。`/watch add` は最初に成功した 1 アカウントで X 側を設定し、残りは `ReceiverSupervisor` の 10 分周期の照合で揃える。
- 受信アカウントの追加・削除は `ReceiverSupervisor` が 1 分ごとに DB を読み直して反映する。認証情報の更新だけは再起動が要る。
- 内部 GraphQL の query ID と feature 一覧は fa0311/TwitterInternalAPIDocument から 6 時間 TTL で取得し、取得失敗時は前回値を使い続ける。
- 生応答 (AutoPush フレーム、GraphQL 応答、X との登録応答) は保存する。PoC 実測で GraphQL 応答は 1 件 200KB あるため、`RAW_RETENTION_DAYS` で本文だけ先に落とし、行は `RETENTION_DAYS` まで残す。
- `/health` は Discord 接続だけで判定する。AutoPush の再接続はプロセス内で完結し、コンテナ再起動では回復が早まらないため。

## Testing

- DB は `openDatabase(":memory:")`、HTTP は `fetchImplementation` 引数、Discord 送信は `DiscordPostSender` の偽実装で差し替える。`tests/helpers/database.ts` に共通の組み立てがある。
- 実ネットワークに出るテストは書かない。

## Git

- `main` への直接コミットは lefthook が止める。ブランチを切って PR にする。
- コミットメッセージは `[type] short description` (type: feat, fix, docs, refactor, test, chore)。
- PR タイトルと本文は日本語で書く。
- Release: `package.json` の version を上げ、`bun run changelog` で CHANGELOG.md を生成し、タグを打って GitHub Release を公開すると Coolify へデプロイされる。

## Gotchas

- `mise.toml` の bun 版が SSOT。`Dockerfile` の base image タグと `bun.lock` の `bun-types` を同じ patch に揃えないと CI の drift-check が落ちる。
- Bun の `.env` 自動読み込みは `bun run` 経由で効かないことがあるため、`src/config/index.ts` が `.env.local` と `.env` を自分で読む。
- `bun:sqlite` の `changes` は外部キーの連鎖削除分も含む。削除件数の厳密な検証には使わない。
- X 側の仕様が変わったときは `/admin/exchanges` と `/admin/observations?errors=1` で生応答を確認する。
