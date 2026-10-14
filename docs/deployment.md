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

ボリュームは初回の Deploy より前に付ける。
マウント設定は次のデプロイで反映されるため、後から付けるとそのデプロイで空のボリュームが載り、それまでにコンテナ内へ書かれた受信アカウントと監視対象は失われる。

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

`.github/workflows/deploy.yml` は Release の公開時に Coolify の Deploy Webhook を呼び、新しい版が本番で動き始めるまで待つ。

1. Coolify のアプリ設定 **Webhooks** にある Deploy Webhook の URL を控える。形は `https://<Coolify のホスト>/api/v1/deploy?uuid=<アプリの UUID>&force=false` である。
2. Coolify の **Security** → **API Tokens** で、権限に `deploy` を付けたトークンを発行する。トークンは作成時にしか表示されない。形は `67|...` のような文字列である。
3. GitHub リポジトリの **Settings** → **Secrets and variables** → **Actions** に次を登録する。

| Secret | 値 |
| ------ | -- |
| `COOLIFY_WEBHOOK` | Deploy Webhook の URL (`/api/v1/deploy?uuid=...` を含む) |
| `COOLIFY_TOKEN` | `deploy` 権限の API トークン |

1. 同じ画面の **Variables** に、本番の `/health` の URL を `PRODUCTION_HEALTH_URL` として登録する (例: `https://<ドメイン>/health`)。

以後は GitHub Release を公開するとデプロイが走る。
デプロイ API の成功は Coolify がデプロイ要求を受け付けたことしか示さず、Coolify は新しいコンテナのヘルスチェックが通らないと旧コンテナへ戻す。
そのため workflow は続けて `scripts/wait-for-deploy.sh` を実行する。
`/health` が `package.json` の版を返し、そのプロセスがデプロイ要求の後に起動して 180 秒動き続けたら成功、15 分以内にそうならなければ失敗する。
180 秒は、新しいコンテナの起動から約 105 秒で旧コンテナへ戻された実例 (2026-10-13) に余裕を持たせた値である。
失敗したときは Coolify のデプロイログで、ヘルスチェックの失敗による戻しか、ビルドの失敗かを確かめる。
workflow のログで応答が `302` かつ本文がログイン画面へのリダイレクトなら、`COOLIFY_WEBHOOK` が API ではなく管理画面の URL を指している。
`401` ならトークンが無効か `deploy` 権限が無い。
Secret を直したあとは、失敗した workflow を GitHub Actions の **Re-run jobs** で再実行すればよく、Release を作り直す必要はない。

## 6. GHCR へのイメージ公開

`.github/workflows/publish-image.yml` は、Coolify へのデプロイと同じ Release の公開を契機に Docker イメージをビルドし、`ghcr.io/atefandrus/ratatoskr` へ push する。
Coolify はリポジトリから自分でビルドするため、このイメージを使わない。

- prerelease の公開では動かず、prerelease を後から正式版に変えたときに動く。Coolify へのデプロイ（`deploy.yml`）は Release の公開で動くので、prerelease を正式版に変えたときはイメージの公開だけが動く。GitHub Actions の画面から手動実行もできる。
- タグは Release のタグ名 (`v0.7.0` など) とコミットの完全な SHA の 2 つで、`latest` は付けない。手動実行では完全な SHA だけを付ける。
- Release のタグ名は `v<major>.<minor>.<patch>` の形でなければ失敗する。
- push の前に各タグがレジストリに既にあるかを確かめ、あれば push せずに失敗する。GHCR はタグを書き換え不可にできないため、同じタグの上書きをここで防ぐ。存在を確かめられなかった場合 (認証やネットワークの失敗) も push しない。
- そのため、push まで済んだ実行の再実行や、Release で公開済みのコミットでの手動実行は失敗する。公開済みのコミットに新しい Release を付けても、コミットの SHA のタグが重なるので失敗する。出し直すには新しいコミットが要り、Release 経由なら、その新しいコミットに Release を作る。
- イメージを使う側はタグではなく digest で固定する。
- push した digest には `actions/attest` で build provenance を付け、GHCR に置く。`gh attestation verify oci://ghcr.io/atefandrus/ratatoskr@<digest> --repo AtefAndrus/ratatoskr` で検証できる。

個人アカウントの package は初回公開時に private で作られる。
初回の公開が済んだら、リポジトリ所有者が GitHub のプロフィールの **Packages** から `ratatoskr` を開き、**Package settings** の **Danger Zone** → **Change visibility** で **Public** に切り替える。
public から private へは戻せない。

## 7. 動作確認

- `/health` が 200 を返し、本文の `receivers[].autopushConnected` が `true` になっている。
- Coolify のログに `Target configured on receiver` が出ていれば、追加した受信アカウントにも監視対象のフォローが行き渡っている。
- 管理 API の使い方は [admin-api.md](admin-api.md) を参照する。

## トラブルシューティング

| 症状 | 確認 |
| ---- | ---- |
| `Receiver provisioning failed` が繰り返し出る | ログの `error` を見る。X が 401/403 を返しているなら Cookie の失効なので `bun run cli receiver:update <label>` で更新する (再起動は不要)。それ以外は Mozilla AutoPush か DB 側の障害で、Cookie を入れ直しても直らない |
| `/watch add` が「X 側の設定に失敗しました」を返す | 受信アカウントが未登録か、Cookie が失効している。`/admin/exchanges?source=x_target_notifications` で応答を見る |
| 通知が届かない | `/admin/metrics` の `receivers[].lastNotificationAt` と `/admin/observations?errors=1` を見る |
| 同じ投稿が 2 回届く | 同じチャンネルへ同じ対象の経路が 2 本ある。`/watch list` で確認する |
