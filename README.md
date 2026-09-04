# ratatoskr

監視対象の X アカウントの投稿 URL を Discord チャンネルへ中継する Bot である。
名前は北欧神話でユグドラシルの梢と根の間を駆けて言葉を運ぶリスに由来する。

X 公式 API は使わない。
受信用の X アカウントで監視対象をフォローし、X が Firefox 向けに送る Web Push 通知を Mozilla AutoPush から直接受信して復号する。
Web Push が配信しない返信は、X の内部 GraphQL を適応間隔でポーリングして補完する。
両経路で検出した投稿は、Discord チャンネルごとに一度だけ送る。

## 構成

```text
X (通知)  ──Web Push──▶ Mozilla AutoPush ──WebSocket──▶ ┐
                                                        ├─▶ 復号・解析・重複排除 ──▶ Discord チャンネル
X (内部 GraphQL) ◀──適応ポーリング── 受信アカウント ──▶ ┘
```

- ランタイムは Bun 1.4 で、`mise.toml` の版を唯一の正とする。
- 永続化は SQLite 1 ファイルで、受信アカウントの認証情報と Web Push 鍵、監視対象、経路、通知と観測の生データを保存する。
- デプロイ先は Coolify で、GitHub Release の公開を契機に webhook でデプロイする。
- Linter と Formatter は oxlint と oxfmt を使う。

## Discord コマンド

コマンドは `Manage Server` 権限を持つメンバーがサーバー内で実行できる。

| コマンド | 説明 |
| -------- | ---- |
| `/watch add account:<X アカウント名> [channel:<チャンネル>]` | 監視対象を追加し、投稿先チャンネルを紐づける。チャンネル省略時は実行したチャンネル |
| `/watch remove account:<X アカウント名> [channel:<チャンネル>]` | 紐づけを削除する。投稿先が無くなった対象はポーリングを止める |
| `/watch list` | このサーバーの監視対象と投稿先チャンネルの一覧を表示する |

監視対象と投稿先チャンネルは n:m で対応する。
同じアカウントを複数のチャンネルへ流すことも、複数のアカウントを 1 つのチャンネルへ集約することもできる。

`/watch add` は受信アカウントで対象をフォローし、投稿通知とリポスト通知を有効化してから経路を登録する。
受信アカウントが複数ある場合、残りのアカウントには監督ループが 10 分以内に同じ設定を行き渡らせる。

## 受信用 X アカウント

受信アカウントは専用の捨てアカウントを使い、CLI で登録する。
複数登録すると全アカウントがすべての監視対象をフォローし、どれか 1 つが通知を落としても他が補う。
Discord への送信は経路と投稿の組で重複排除するため、複数アカウントが同じ通知を受けても 1 回しか送らない。

ブラウザで受信アカウントにログインし、Cookie の `auth_token` と `ct0` を控える。
値はコマンド引数に渡さず、実行後の非表示入力で貼り付ける。

```bash
bun run cli receiver:add <label>
```

Coolify のコンテナ内で実行する場合は、Coolify の Terminal から同じコマンドを使う。
端末が無い環境では環境変数 `X_AUTH_TOKEN` と `X_CT0` から読む。

```bash
bun run cli receiver:list
bun run cli receiver:update <label>
bun run cli receiver:disable <label>
bun run cli receiver:enable <label>
bun run cli receiver:remove <label>
bun run cli watch:list
```

Bot は 1 分ごとに受信アカウントの一覧を読み直すため、追加と削除に再起動は要らない。
認証情報の更新だけは再起動が必要である。

Bot は受信アカウントごとに AutoPush の購読を作成し、X の `notifications/settings/login.json` へ登録する。
購読情報と Web Push の秘密鍵は SQLite に保存する。
コンテナでは環境変数とデータボリュームの信頼境界が同じであるため、鍵を別の場所に置く利点が無い。

## 環境変数

| 名前 | 必須 | 既定値 | 説明 |
| ---- | ---- | ------ | ---- |
| `DISCORD_TOKEN` | Yes | | Discord Bot Token |
| `DISCORD_APPLICATION_ID` | Yes | | Discord Application ID |
| `NODE_ENV` | No | `development` | 動作モード |
| `DATABASE_PATH` | No | `data/ratatoskr.db` | SQLite パス。Docker イメージでは `/app/data/ratatoskr.db` |
| `HEALTH_PORT` | No | `3000` | `/health` と `/admin/*` の HTTP ポート |
| `ADMIN_API_SECRET` | No | | 管理 API の HMAC 共通シークレット。未設定なら `/admin/*` は 503 |
| `INTERNAL_POLL_ENABLED` | No | `true` | 内部 GraphQL による返信補完ポーリングを行うか |
| `RAW_RETENTION_DAYS` | No | `3` | 生応答本文を保持する日数 |
| `RETENTION_DAYS` | No | `30` | 通知・観測・配信の記録行を保持する日数 |
| `X_WEB_BEARER_TOKEN` | No | 組み込み値 | X Web クライアントの公開 Bearer |

## セットアップ

```bash
mise install
mise run setup
```

`.env` に `DISCORD_TOKEN` と `DISCORD_APPLICATION_ID` を書く。
Discord Developer Portal では OAuth2 スコープに `bot` と `applications.commands` を指定し、Bot には対象チャンネルの `View Channels`、`Send Messages`、`Embed Links` を許可する。
Gateway Intent は `Guilds` だけを使う。

```bash
bun run cli receiver:add main
bun dev
```

起動時に Slash Command をグローバル登録する。
反映まで最大 1 時間かかることがある。

## 開発

```bash
bun run check        # format:check, lint, typecheck, test, lint:md をまとめて実行
bun run format       # oxfmt で整形
bun run lint:fix     # oxlint の自動修正
bun test
```

コミット前に lefthook が同じ検査を走らせる。
main への直接コミットは lefthook が止める。

VS Code では `oxc.oxc-vscode` 拡張が整形と Lint を担当する。

## 運用データと管理 API

X 側の仕様変更を追えるよう、AutoPush の生フレーム、復号済みペイロード、内部 GraphQL の生応答、X との登録やフォローの応答を SQLite に保存する。
生応答本文は `RAW_RETENTION_DAYS` を過ぎると本文だけ削除し、行そのものは `RETENTION_DAYS` まで残す。
重複排除の根拠である配信 claim は削除しない。

保存したデータは HMAC 認証付きの読み取り専用 API から取得できる。
エンドポイントと署名手順は [docs/admin-api.md](docs/admin-api.md) に記載する。

## デプロイ

Coolify のアプリ作成、永続ボリューム、環境変数、GitHub Release からの自動デプロイの手順は [docs/deployment.md](docs/deployment.md) に記載する。

## 制約

- X の Push 登録リクエスト形式と VAPID 公開鍵は、第三者の静的解析資料と実ブラウザの挙動から得たもので、X が変更すると受信が止まる。
- X の内部 GraphQL の query ID と feature 一覧は起動時と 6 時間ごとに [fa0311/TwitterInternalAPIDocument](https://github.com/fa0311/TwitterInternalAPIDocument) から取得する。取得先が止まると前回の値を使い続ける。
- 受信アカウントは X の利用規約上リスクを負う。専用の捨てアカウントを使う。
- 通知タイトル (表示名) が複数の監視対象で同一だと通知主体を一意にできず、その通知は保存だけして送らない。

## ライセンス

MIT
