# ratatoskr

<img src="assets/icon.png" alt="ratatoskr" width="128" align="right">

監視対象の X アカウントの投稿 URL を Discord チャンネルへ中継する Bot である。
名前は北欧神話でユグドラシルの梢と根の間を駆けて言葉を運ぶリスに由来する。

X 公式 API は使わない。
受信用の X アカウントで監視対象をフォローし、X が Firefox 向けに送る Web Push 通知を Mozilla AutoPush から直接受信して復号する。
Web Push が配信しない返信は、X の内部 GraphQL を適応間隔で取得して補完する。
両経路で検出した投稿は、Discord チャンネルごとに一度だけ送る。

## 仕組み

```text
X (通知)  ──Web Push──▶ Mozilla AutoPush ──WebSocket──▶ ┐
                                                        ├─▶ 復号・解析・重複排除 ──▶ Discord チャンネル
X (内部 GraphQL) ◀──適応ポーリング── 受信アカウント ──▶ ┘
```

- **受信アカウント**：監視対象をフォローし、通知を受け取る専用の X アカウント。CLI で登録し、複数あれば互いの取りこぼしを補う。
- **監視対象**：投稿を中継する X アカウント。Discord の `/watch add` で登録する。
- **経路**：監視対象と投稿先チャンネルの組。n:m で対応し、同じ対象を複数チャンネルへ流すことも、複数の対象を 1 つのチャンネルへ集約することもできる。

ランタイムは Bun、永続化は SQLite 1 ファイル、デプロイ先は Coolify である。

## はじめかた

1. Discord Developer Portal でアプリケーションを作り、Bot Token と Application ID を控える。設定値は [docs/setup.md](docs/setup.md#discord-アプリケーション) を参照する。
2. 依存を入れ、秘密情報を `.env.local` に書く。

   ```bash
   mise install
   mise run setup
   bun run cli env:set DISCORD_TOKEN
   bun run cli env:set DISCORD_APPLICATION_ID
   ```

3. 受信用の X アカウント (捨てアカウント) の Cookie を控え、CLI で登録する。値の取り方は [docs/setup.md](docs/setup.md#受信用-x-アカウント) を参照する。

   ```bash
   bun run cli receiver:add main
   ```

4. 起動する。

   ```bash
   bun dev
   ```

5. Bot を招待したサーバーで `/watch add account:<X アカウント名>` を実行する。

本番へは Coolify にデプロイする。手順は [docs/deployment.md](docs/deployment.md) を参照する。

## コマンド

コマンドは `Manage Server` 権限を持つメンバーがサーバー内で実行できる。

| コマンド | 説明 |
| -------- | ---- |
| `/watch add account:<X アカウント名> [channel:<チャンネル>] [posts/quotes/reposts/replies:<true か false>]` | 監視対象を追加し、投稿先チャンネルを紐づける。アカウント名は登録済みのものが候補に出るが自由入力もできる。チャンネル省略時は実行したチャンネル。登録済みの組に再実行すると、指定した種別だけを更新する |
| `/watch remove account:<X アカウント名> [channel:<チャンネル>]` | 紐づけを削除する。アカウント名は登録済みのものから補完で選べる |
| `/watch list` | このサーバーの監視対象、投稿先チャンネル、投稿 URL のドメイン設定を表示する |
| `/watch domain [domain:<x.com か fixupx.com か fixvx.com>]` | 投稿 URL のドメインをサーバー単位で設定する。省略時は現在の設定を表示する |

- `/watch add` は受信アカウントで対象をフォローし、投稿通知とリポスト通知を有効化してから経路を登録する。受信アカウントが複数ある場合、残りには 10 分以内に同じ設定が行き渡る。
- 送る投稿の種別は経路ごとに通常投稿、引用、リポスト、返信の 4 つを個別に選べ、既定はすべて送る。投稿が持つ種別のどれかを許可していれば送る (返信を兼ねた引用は、返信か引用のどちらかを許可していれば届く)。Web Push の通知では通常投稿と引用を区別できないため、両者の扱いが違う経路があるときだけ内部 GraphQL で投稿 1 件を引いて種別を確定する。
- `/watch remove` で投稿先が無くなった対象は、投稿の取得を止める。X 側のフォローは残すので、再登録すると即座に受信を再開する。
- `/watch domain` で `fixupx.com` などを選ぶと、そのサーバーへ送る投稿 URL のホストを x.com から置き換え、動画や複数画像の埋め込みを整形する外部サービスを経由させる。重複排除は投稿 ID で行うため、ドメインを変えても同じ投稿が二度届くことはない。
- 追加と削除の結果は公開メッセージで返し、一覧とエラーは実行者だけに見える。

受信アカウントの管理コマンドは [docs/setup.md](docs/setup.md#受信用-x-アカウント) を参照する。

## 環境変数

| 名前 | 必須 | 既定値 | 説明 |
| ---- | ---- | ------ | ---- |
| `DISCORD_TOKEN` | Yes | | Discord Bot Token |
| `DISCORD_APPLICATION_ID` | Yes | | Discord Application ID |
| `NODE_ENV` | No | `development` | 動作モード。Docker イメージでは `production` |
| `DATABASE_PATH` | No | `data/ratatoskr.db` | SQLite パス。Docker イメージでは `/app/data/ratatoskr.db` |
| `HEALTH_PORT` | No | `3000` | `/health` と `/admin/*` の HTTP ポート |
| `ADMIN_API_SECRET` | No | | 管理 API の HMAC 共通シークレット。未設定なら `/admin/*` は 503 |
| `ADMIN_ALERT_CHANNEL_ID` | No | | 受信アカウントの認証切れを知らせる Discord チャンネル ID。未設定なら通知しない |
| `INTERNAL_POLL_ENABLED` | No | `true` | 内部 GraphQL による返信補完を行うか |
| `RAW_RETENTION_DAYS` | No | `1` | 生応答本文を保持する日数 |
| `RETENTION_DAYS` | No | `30` | 通知・観測・配信の記録行を保持する日数 |
| `X_WEB_BEARER_TOKEN` | No | 組み込み値 | X Web クライアントの公開 Bearer |

## 運用

- **デプロイ**：Coolify のアプリ作成、永続ボリューム、環境変数、GitHub Release からの自動デプロイは [docs/deployment.md](docs/deployment.md) に記載する。
- **運用データ**：X 側の仕様変更を追えるよう、AutoPush の生フレーム、復号済みペイロード、内部 GraphQL の生応答、X との登録やフォローの応答を SQLite に保存する。生応答本文は `RAW_RETENTION_DAYS` を過ぎると本文だけ削除し、行は `RETENTION_DAYS` まで残す。重複排除の根拠である配信 claim は削除しない。
- **管理 API**：保存したデータは HMAC 認証付きの読み取り専用 API から取得できる。エンドポイントと署名手順は [docs/admin-api.md](docs/admin-api.md) に記載する。

### 制約

- X の Push 登録リクエスト形式と VAPID 公開鍵は、第三者の静的解析資料と実ブラウザの挙動から得たもので、X が変更すると受信が止まる。
- 内部 GraphQL の query ID と feature 一覧は起動時と 6 時間ごとに [fa0311/TwitterInternalAPIDocument](https://github.com/fa0311/TwitterInternalAPIDocument) から取得する。取得先が止まると前回の値を使い続ける。
- 受信アカウントは X の利用規約上リスクを負う。専用の捨てアカウントを使う。
- 通知タイトル (表示名) が複数の監視対象で同一だと通知主体を一意にできず、その通知は保存だけして送らない。

## 開発

```bash
bun run check        # format:check, lint, typecheck, test, lint:md をまとめて実行
bun run format       # oxfmt で整形
bun run lint:fix     # oxlint の自動修正
bun test
```

oxlint と oxfmt の版は `package.json` の devDependencies に固定し、Renovate が `oxlint-tsgolint` と合わせて 1 本の PR で上げる。
設定ファイルの `$schema` は `node_modules` 内のスキーマを指すため、版を上げると設定の検証も追従する。
VS Code の `oxc.oxc-vscode` 拡張はバイナリを同梱せず、`node_modules` の oxlint と oxfmt を自動検出して使う。

コミット前に lefthook が `bun run check` と同じ検査を走らせる。
main への直接コミットは lefthook が止める。

リリースは `package.json` の version を上げ、`mise exec -- git-cliff --tag v<version> --output CHANGELOG.md` で CHANGELOG を生成してマージし、タグと GitHub Release を公開する。
Release の公開で Coolify へデプロイされる。

## ライセンス

MIT
