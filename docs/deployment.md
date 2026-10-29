# 本番へのデプロイ

本番の ratatoskr は、Flux で管理する Kubernetes のクラスタ (talos2) の namespace `personal` で動く。
Kubernetes の定義は private リポジトリ AtefAndrus/k8s-tenant-personal の `apps/ratatoskr/` にあり、このリポジトリには置かない。
GitHub Release を公開すると GHCR へイメージが公開され、Flux がそのイメージの tag と digest を定義へ書き戻して起動し直す。

## 前提

- Discord Developer Portal で Bot を作成し、Bot Token と Application ID を控えている。
- 受信用の X アカウントを用意し、ブラウザでログインして Cookie の `auth_token` と `ct0` を控えている。
- talos2 の kubeconfig を持ち、namespace `personal` で `kubectl` を使える。

## 1. 構成

| 定義 (`apps/ratatoskr/`) | 内容 |
| ---- | ---- |
| `statefulset.yaml` | `replicas: 1` の StatefulSet `ratatoskr`。Pod は `ratatoskr-0` になる。イメージは `ghcr.io/atefandrus/ratatoskr:<tag>@<digest>` で固定し、`/health` を readinessProbe で 30 秒ごとに見る |
| `pvc.yaml` | SQLite の置き場の PersistentVolumeClaim `ratatoskr-data` (`/app/data` にマウント)。定義を消してもデータが消えないよう、Flux の prune を止めている |
| `secret.sops.yaml` | 環境変数の Secret `ratatoskr-env` (SOPS で暗号化)。StatefulSet が `envFrom` で読む |
| `service.yaml` | 管理 API の Service。基盤の Tailscale Ingress (machine 名 `talos2-personal-ratatoskr`) の backend になり、tailnet の中だけに HTTPS で公開される |
| `image.yaml`、`image-update.yaml` | Release のイメージを拾って `statefulset.yaml` の image 行へ書き戻す Flux の image automation (「4. Release からのデプロイ」を参照) |

StatefulSet は旧 Pod を止めてから新しい Pod を起動するので、デプロイのたびに短い停止がある。
同じ Discord の Token で 2 つのプロセスが接続しないよう、別の環境で動かすときは片方の停止を確認してからもう片方を起動する。

## 2. 永続ボリュームと環境変数

SQLite に受信アカウントの認証情報、Web Push の鍵、監視対象、運用データを保存するので、PersistentVolumeClaim `ratatoskr-data` を `/app/data` にマウントする。
`DATABASE_PATH` は Dockerfile で `/app/data/ratatoskr.db` に設定済みなので指定しない。

Secret `ratatoskr-env` には少なくとも次を入れる。

| 名前 | 値 |
| ---- | -- |
| `DISCORD_TOKEN` | Bot Token |
| `DISCORD_APPLICATION_ID` | Application ID |
| `ADMIN_API_SECRET` | `openssl rand -hex 32` で生成した値 |

その他の値は README の環境変数一覧を参照する。

## 3. 受信アカウントの登録

起動して `kubectl logs -n personal ratatoskr-0` に `Discord client ready` と `HTTP server started` が出たら、Pod の中で受信アカウントを登録する。
CLI は Cookie を非表示入力で受け取るので、`-it` を付ける。
値の取り方と CLI の詳細は [setup.md](setup.md#受信用-x-アカウント) を参照する。

```bash
kubectl exec -it -n personal ratatoskr-0 -- bun run cli receiver:add main
```

1 分以内にログへ `AutoPush subscription created` と `Web Push subscription registered with X` が出れば受信を開始している。
続けて Discord サーバーで `/watch add account:<X アカウント名>` を実行し、監視対象を登録する。

## 4. Release からのデプロイ

GitHub Release を公開すると、次の順に本番が新しいバージョンへ切り替わる。

1. `.github/workflows/publish-image.yml` がイメージをビルドし、Release のタグ名 (`v0.8.9` など) で GHCR へ push する (「5. GHCR へのイメージ公開」を参照)。
2. Flux の ImageRepository と ImagePolicy (`image.yaml`) が、`v<major>.<minor>.<patch>` の形のタグのうち semver で最も新しいものと、その digest を選ぶ。
3. ImageUpdateAutomation (`image-update.yaml`) が、選んだ tag と digest を k8s-tenant-personal の main の `statefulset.yaml` へコミットする。コミットのメッセージは `Update the ratatoskr image to ...` になる。
4. Flux がその変更を適用し、StatefulSet が Pod を新しいイメージで起動し直す。

ImageRepository と ImageUpdateAutomation はどちらも 30 分間隔で動くので、Release の公開から切り替わるまで 1 時間ほどかかることがある。
切り替わったかは、tailnet から `https://talos2-personal-ratatoskr.<tailnet の名前>.ts.net/health` の `version` と `startedAt` で確認する。

起動時のマイグレーションが確定した後でイメージを前のバージョンへ戻すと、DB のスキーマが新しすぎて前のバージョンは起動を拒む (`src/db/schema.ts` の `applyMigrations`)。
スキーマを上げるリリースで問題が出たときは、前のバージョンへ戻さずに、直したバージョンを出し直す。

## 5. GHCR へのイメージ公開

`.github/workflows/publish-image.yml` は、Release の公開を契機に Docker イメージをビルドし、`ghcr.io/atefandrus/ratatoskr` へ push する。

- prerelease の公開では動かず、prerelease を後から正式版に変えたときに動く。GitHub Actions の画面から手動実行もできる。
- タグは Release のタグ名 (`v0.7.0` など) とコミットの完全な SHA の 2 つで、`latest` は付けない。手動実行では完全な SHA だけを付ける。
- Release のタグ名は `v<major>.<minor>.<patch>` の形でなければ失敗する。
- push の前に各タグがレジストリに既にあるかを確かめ、あれば push せずに失敗する。GHCR はタグを書き換え不可にできないため、同じタグの上書きをここで防ぐ。存在を確かめられなかった場合 (認証やネットワークの失敗) も push しない。
- そのため、push まで済んだ実行の再実行や、Release で公開済みのコミットでの手動実行は失敗する。公開済みのコミットに新しい Release を付けても、コミットの SHA のタグが重なるので失敗する。出し直すには新しいコミットが要り、Release 経由なら、その新しいコミットに Release を作る。
- イメージを使う側はタグではなく digest で固定する。本番の定義も tag と digest の両方を書く。
- push した digest には `actions/attest` で build provenance を付け、GHCR に置く。`gh attestation verify oci://ghcr.io/atefandrus/ratatoskr@<digest> --repo AtefAndrus/ratatoskr` で検証できる。

個人アカウントの package は初回公開時に private で作られる。
初回の公開が済んだら、リポジトリ所有者が GitHub のプロフィールの **Packages** から `ratatoskr` を開き、**Package settings** の **Danger Zone** → **Change visibility** で **Public** に切り替える。
public から private へは戻せない。

## 6. 動作確認

- `/health` が 200 を返し、本文の `receivers[].autopushConnected` が `true` になっている。
- `kubectl logs -n personal ratatoskr-0` に `Target configured on receiver` が出ていれば、追加した受信アカウントにも監視対象のフォローが行き渡っている。
- 管理 API の使い方は [admin-api.md](admin-api.md) を参照する。

## トラブルシューティング

| 症状 | 確認 |
| ---- | ---- |
| `Receiver provisioning failed` が繰り返し出る | ログの `error` を見る。X が 401/403 を返しているなら Cookie の失効なので `bun run cli receiver:update <label>` で更新する (再起動は不要)。それ以外は Mozilla AutoPush か DB 側の障害で、Cookie を入れ直しても直らない |
| `/watch add` が「X 側の設定に失敗しました」を返す | 受信アカウントが未登録か、Cookie が失効している。`/admin/exchanges?source=x_target_notifications` で応答を見る |
| 通知が届かない | `/admin/metrics` の `receivers[].lastNotificationAt` と `/admin/observations?errors=1` を見る |
| 同じ投稿が 2 回届く | `/admin/posts/<postId>` でたどる (読み方は [admin-api.md](admin-api.md#投稿-1-件をたどる))。別の監視対象の投稿先が同じチャンネルを指していてリポストが両方から届いた場合や、Discord が受理した後で送信済みを記録する前にプロセスが止まって送り直した場合がある |
| Release を出してもバージョンが変わらない | k8s-tenant-personal に `Update the ratatoskr image to ...` のコミットが入ったかを見る。入っていなければ Flux の ImagePolicy と ImageUpdateAutomation の状態を、入っていれば StatefulSet の rollout と Pod のログを見る |
