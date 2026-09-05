# 管理 API

Bot に組み込まれた HMAC 認証付きの読み取り専用 HTTP API である。
`/health` と同じ Bun サーバーから提供する。
X 側の仕様変更を調査するために、保存した生データをそのまま読める。

## エンドポイント

| パス | 説明 | クエリ |
| ---- | ---- | ------ |
| `/admin/metrics` | プロセス、Discord、受信アカウント状態、カウンタ、テーブル行数 | |
| `/admin/logs` | メモリ上の直近ログ (最大 5000 行) | `level`, `lines`, `since` |
| `/admin/receivers` | 受信アカウント一覧 (秘密情報を含まない) と稼働状態 | |
| `/admin/targets` | 監視対象と経路の一覧 | |
| `/admin/notifications` | Web Push の解析結果と復号済みペイロード | `limit`, `kind` (`post`, `other`, `malformed`) |
| `/admin/deliveries` | Discord 送信の試行履歴 | `limit`, `status` (`sent`, `failed`, `skipped_duplicate`) |
| `/admin/observations` | 内部 GraphQL の観測メタデータ | `limit`, `target`, `errors=1` |
| `/admin/observations/<id>` | 観測 1 件の生応答本文と抽出した投稿 | |
| `/admin/exchanges` | X や参照データ取得元との HTTP やり取り | `limit`, `source` |

`limit` は 1 から 1000 で既定は 50 である。
GET 以外は `405` を返す。

`source` の値は `x_push_registration`、`x_target_notifications`、`x_tweet_lookup` (Web Push で通常投稿と引用を区別するための投稿 1 件の取得)、`x_internal_api_document`、`x_transaction_pairs` である。

## 認証

| ヘッダ | 形式 |
| ------ | ---- |
| `X-Admin-Timestamp` | Unix epoch milliseconds の 10 進文字列 |
| `X-Admin-Signature` | `sha256=<hex>` 形式の HMAC-SHA256 |

署名対象は次の文字列で、LF 区切りで末尾改行を付けない。

```text
${METHOD}\n${path}\n${canonicalQuery}\n${timestamp}
```

`canonicalQuery` はクエリを `key` 昇順、同一 `key` 内は `value` 昇順で並べ、`encodeURIComponent` した `key=value` を `&` で連結したものである。
クエリが無ければ空文字である。

- `ADMIN_API_SECRET` が未設定なら `503`
- タイムスタンプが欠落、数値以外、5 分のドリフト窓を外れると `401`
- 署名が欠落または不一致なら `401`

## 叩き方

`bun run cli admin <path> [query]` が署名を組み立てて叩く。

```bash
export ADMIN_API_SECRET=...
export ADMIN_BASE_URL=https://bot.example.com   # 既定は http://localhost:3000

bun run cli admin /admin/metrics | jq .
bun run cli admin /admin/observations "errors=1&limit=20" | jq .
bun run cli admin /admin/observations/123 | jq -r .responseText | head -c 2000
bun run cli admin /admin/logs "level=warn&lines=100"
```

クエリの並び順は署名時に正規化するので、呼び出し側で `key` 昇順に揃える必要はない。
200 以外のときは状態コードと本文を標準エラーへ出して終了コード 1 で終わるので、`jq` にパースエラーだけが渡ることはない。
ただし `jq` へパイプすると、`set -o pipefail` の無いシェルではパイプ全体の終了コードが `jq` のものになる。
スクリプトから呼ぶときは `set -o pipefail` を付けるか、パイプせずに終了コードを見る。

署名を自前で組み立てる形は用意していない。
`canonicalQuery` はサーバ側で値を decode してから `key` 昇順・同一 `key` 内は `value` 昇順に並べ、`encodeURIComponent` で再エンコードしたものになる。
`since=2026-09-05T00:00:00Z` のコロンが `%3A` になるといった差まで一致させる必要があり、シェルで組み立てると 401 の原因が署名なのか鍵なのか切り分けられなくなる。
本番のコンテナは `oven/bun` なので、Coolify の Terminal からでも `bun run cli admin` が使える。

## よくある調査

| 問い | 見る場所 | 読み方 |
| ---- | -------- | ------ |
| rate limit に余裕があるか | `/admin/observations` の `rateLimitLimit`、`rateLimitRemaining`、`rateLimitResetAt` | 上限は応答ヘッダから取るので `rateLimitLimit` を見る (2026-09-05 の実測では 500 / 15 分)。`rateLimitRemaining` が `AdaptivePollScheduler` の予約枠 100 に近づくとポーリングが止まるので、そこまでの余裕で判断する |
| 監視対象が分担できているか | `/admin/metrics` の `receivers[].internalPoll.targets` | どの対象も原則 2 台に載る。受信 2 台以下では全員が全対象を持つ。担当がゼロになる受信には認証確認用に 1 件を足すため、対象が受信より少ない構成では 3 台以上に載る対象が出る |
| 受信アカウントの認証が生きているか | `/admin/observations?errors=1` の `responseStatus` と `error` | 401 と 403 は X が資格情報を拒んだことを示す (Cookie の失効が典型だが、それだけとは限らない)。`responseStatus` が `null` で `error` が入っているものは要求が届かなかった側で、認証とは別物 (`The operation timed out.` や `getaddrinfo ETIMEOUT x.com` など文言は一定しない) |
| X との個別のやり取りを見たいとき | `/admin/exchanges` を `source` で絞る | Cookie を使うのは `x_target_notifications`、`x_push_registration`、`x_tweet_lookup` の 3 つ。`x_internal_api_document` と `x_transaction_pairs` は GitHub からの参照データ取得で、そこの 403 は Cookie とは無関係 |
| 内部ポーリングの周回が間に合っているか | `/admin/observations` を `target` で絞り、`receiverLabel` ごとに `fetchedAt` の差を見る | 間隔は対象ごとに変わる。新着があれば約 60 秒、無風が続くと 90/120/180 秒、失敗すると 30/60/120/300 秒 (最初の失敗はむしろ短くなる)。これに ±10% のジッタ、受信内の待ち行列、rate limit による間隔調整が乗る。全体の件数から平均を出しても個別の間隔は復元できない |
| 内部 GraphQL の生応答がどれだけ容量を食っているか | `/admin/observations/<id>` の `responseText` の長さ と `/admin/metrics` の `tables` | 1 観測あたりのバイト数 × 日次の観測数 × `RAW_RETENTION_DAYS`。`RAW_RETENTION_DAYS` は他に投稿の `raw_result_json`、AutoPush の生フレームと暗号文、`external_exchanges` の応答本文も落とすので、この式で出るのは内部 GraphQL 応答本文ぶんだけ |
| DB 全体がどれだけ増えるか | `/admin/metrics` の `dbBytes` を時間をおいて 2 回 | `dbBytes` は DB 本体と WAL と SHM の合計なので、再起動を挟むと WAL のぶん減ることがある。`delivery_claims` は重複排除の根拠なので保持期間では消さず、長期では増え続ける (経路を削除すれば `ON DELETE CASCADE` で一緒に消える)。全体が定常値に収束するとは限らない |
| どちらの経路が先に投稿を拾ったか | `/admin/deliveries` の `status` と `source` | `sent` の `source` は配信権 (claim) を先に取った側。後から同じ投稿を見つけた側は `skipped_duplicate` になる。もう一方が取りこぼしたことを意味しない |

`/admin/observations` と `/admin/exchanges` は `limit` の既定が 50 なので、分布を見るときは `limit=1000` まで上げる。
