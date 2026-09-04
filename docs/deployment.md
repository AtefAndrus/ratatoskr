# Coolify へのデプロイ

ratatoskr を Coolify 上で動かし、GitHub Release の公開を契機に自動デプロイするまでの手順である。

## 前提

- Coolify サーバーが稼働していて、GitHub の AtefAndrus/ratatoskr を読める GitHub App または Deploy Key が設定済みである。
- Discord Developer Portal で Bot を作成し、Bot Token と Application ID を控えている。
- 受信用の X アカウントを用意し、ブラウザでログインして Cookie の `auth_token` と `ct0` を控えている。

## 1. アプリケーションの作成

1. Coolify のプロジェクトで **+ New** → **Public Repository** または **Private Repository (GitHub App)** を選ぶ。
2. リポジトリに `https://github.com/AtefAndrus/ratatoskr` を指定し、ブランチは `main` にする。
3. Build Pack に **Dockerfile** を選ぶ。
4. Port は `3000` にする。
5. Health Check は Dockerfile の `HEALTHCHECK` がそのまま使われる。Coolify 側で別途設定する場合はパス `/health`、ポート `3000` にする。

## 2. 永続ボリューム

SQLite に受信アカウントの認証情報、Web Push 鍵、監視対象、運用データを保存するため、ボリュームを必ず付ける。

| 項目 | 値 |
| ---- | -- |
| Name | `ratatoskr-data` |
| Destination Path | `/app/data` |

ボリュームを付け忘れると、再デプロイのたびに受信アカウントと監視対象が消える。

## 3. 環境変数

| 名前 | 値 |
| ---- | -- |
| `DISCORD_TOKEN` | Bot Token |
| `DISCORD_APPLICATION_ID` | Application ID |
| `ADMIN_API_SECRET` | `openssl rand -hex 32` で生成した値 |

`DATABASE_PATH` は Dockerfile で `/app/data/ratatoskr.db` に設定済みなので指定しない。
その他の値は README の環境変数一覧を参照する。

## 4. 初回デプロイと受信アカウントの登録

1. **Deploy** を押し、ログに `Discord client ready` と `HTTP server started` が出るのを確認する。
2. Coolify の **Terminal** からコンテナへ入り、受信アカウントを登録する。値の取り方と CLI の詳細は [setup.md](setup.md#受信用-x-アカウント) を参照する。

   ```bash
   bun run cli receiver:add main
   ```

   1 分以内にログへ `AutoPush subscription created` と `Web Push subscription registered with X` が出れば受信を開始している。

3. Discord サーバーで `/watch add account:<X アカウント名>` を実行し、監視対象を登録する。

## 5. GitHub Release からの自動デプロイ

`.github/workflows/deploy.yml` は Release の公開時に Coolify の Deploy Webhook を呼ぶ。

1. Coolify のアプリ設定 **Webhooks** で Deploy Webhook URL を控える。
2. Coolify の **Keys & Tokens** → **API tokens** でトークンを発行する。
3. GitHub リポジトリの **Settings** → **Secrets and variables** → **Actions** に次を登録する。

| Secret | 値 |
| ------ | -- |
| `COOLIFY_WEBHOOK` | Deploy Webhook URL |
| `COOLIFY_TOKEN` | API token |

以後は GitHub Release を公開するとデプロイが走る。

## 6. 動作確認

- `/health` が 200 を返し、本文の `receivers[].autopushConnected` が `true` になっている。
- Coolify のログに `Target configured on receiver` が出ていれば、追加した受信アカウントにも監視対象のフォローが行き渡っている。
- 管理 API の使い方は [admin-api.md](admin-api.md) を参照する。

## トラブルシューティング

| 症状 | 確認 |
| ---- | ---- |
| `Receiver provisioning failed` が繰り返し出る | X の Cookie が失効している。`bun run cli receiver:update <label>` で更新して再起動する |
| `/watch add` が「X 側の設定に失敗しました」を返す | 受信アカウントが未登録か、Cookie が失効している。`/admin/exchanges?source=x_target_notifications` で応答を見る |
| 通知が届かない | `/admin/metrics` の `receivers[].lastNotificationAt` と `/admin/observations?errors=1` を見る |
| 同じ投稿が 2 回届く | 同じチャンネルへ同じ対象の経路が 2 本ある。`/watch list` で確認する |
