# 管理 API

Bot に組み込まれた HMAC 認証付きの読み取り専用 HTTP API である。
`/health` と同じ Bun サーバーから提供する。
X 側の仕様変更を調査するために、保存した生データをそのまま読める。

## エンドポイント

| パス | 説明 | クエリ |
| ---- | ---- | ------ |
| `/admin/metrics` | プロセス、Discord、受信アカウント状態、カウンタ、テーブル行数 | |
| `/admin/backlog` | 対象ごとの補完進捗、未送信・送信中・失敗件数、最後の停止理由 | |
| `/admin/logs` | メモリ上の直近ログ (最大 5000 行) | `level`, `lines`, `since` |
| `/admin/receivers` | 受信アカウント一覧 (秘密情報を含まない) と稼働状態 | |
| `/admin/targets` | 監視対象と経路の一覧 | |
| `/admin/notifications` | Web Push の解析結果と復号済みペイロード | `limit`, `kind` (`post`, `other`, `malformed`) |
| `/admin/deliveries` | Discord 送信の試行履歴 | `limit`, `status` (`sent`, `failed`, `skipped_duplicate`) |
| `/admin/observations` | 内部 GraphQL の観測メタデータ | `limit`, `target`, `errors=1` |
| `/admin/observations/<id>` | 観測 1 件の生応答本文と抽出した投稿 | |
| `/admin/posts/<postId>` | 投稿 1 件の通知、観測、対象の投稿先とその投稿先でのキュー状態 | `limit` (観測の行数) |
| `/admin/exchanges` | X や参照データ取得元との HTTP やり取り | `limit`, `source` |

`limit` は 1 から 1000 で既定は 50 である。
GET 以外は `405` を返す。

DB を読む要求は同時に 1 件だけ実行する。
実行中の追加要求は待機せず、`503` と `Retry-After: 5` を返すため、5 秒後に再試行する。
DB 読み取り用の子プロセスが起動から終了と出力の読み取り完了までに 20 秒の期限を超えると、子プロセスを強制終了して `504` を返す。
いずれも本文は `{"error":"..."}` 形式である。
`/admin/logs` は DB を読まないため、この同時実行制限の対象にならない。

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
bun run cli admin /admin/backlog | jq .
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
| ある投稿が届かなかった、または遅れた理由 | `/admin/posts/<postId>` | 下の「投稿 1 件をたどる」を参照する |
| 停止中投稿の補完がどこまで進んだか | `/admin/backlog` の `progress` | `state` が `pending` なら `nextCursor` から再開する。`lastStopReason` は直近ページの保存、429などの取得失敗、既知投稿との重なり、Bottomカーソルの欠落、カーソル循環、固定投稿以外の投稿枠も判別できないエントリも無いページ (`timeline_exhausted`)、投稿枠がすべて `notBefore` より古いページ (`not_before_reached`)、400 ページの上限 (`page_limit_reached`) のいずれで止まったかを示す。`page_limit_reached` では、それより先のページにある停止中の投稿は補完されない。X の応答が変わって終端を判定できなくなった可能性があるので、`/admin/observations/<id>` で直近の補完ページの生応答を確かめる |
| Discord送信が滞留しているか | `/admin/backlog` の `queue` | `pending` は未送信、`sending` は送信中、`failed` は直近の送信に失敗して再試行を待つ件数である。送信中にプロセスが停止した行は次回起動時に `pending` へ戻る |
| rate limit に余裕があるか | `/admin/observations` の `rateLimitLimit`、`rateLimitRemaining`、`rateLimitResetAt` | 上限は応答ヘッダから取るので `rateLimitLimit` を見る (2026-09-05 の実測では 500 / 15 分)。`rateLimitRemaining` が `AdaptivePollScheduler` の予約枠 100 に近づくとポーリングが止まるので、そこまでの余裕で判断する |
| 監視対象が分担できているか | `/admin/metrics` の `receivers[].internalPoll.targets` | どの対象も原則 2 台に載る。受信 2 台以下では全員が全対象を持つ。担当がゼロになる受信には認証確認用に 1 件を足すため、対象が受信より少ない構成では 3 台以上に載る対象が出る。X に 3 回続けて拒否された受信がいると、残りの受信はその受信を除いて分け直し、その受信の担当も重ねて持つ。拒否された受信自身の担当は変わらず、成功が 1 回返れば重ねた分は外れる |
| 受信アカウントの認証が生きているか | `/admin/observations?errors=1` の `responseStatus` と `error` | 401 と 403 は X が資格情報を拒んだことを示す (Cookie の失効が典型だが、それだけとは限らない)。`responseStatus` が `null` で `error` が入っているものは要求が届かなかった側で、認証とは別物 (`The operation timed out.` や `getaddrinfo ETIMEOUT x.com` など文言は一定しない) |
| X との個別のやり取りを見たいとき | `/admin/exchanges` を `source` で絞る | Cookie を使うのは `x_target_notifications`、`x_push_registration`、`x_tweet_lookup` の 3 つ。`x_internal_api_document` と `x_transaction_pairs` は GitHub からの参照データ取得で、そこの 403 は Cookie とは無関係 |
| 内部ポーリングの周回が間に合っているか | `/admin/observations` を `target` で絞り、`receiverLabel` ごとに `fetchedAt` の差を見る | 間隔は対象ごとに変わる。新着があれば約 60 秒、無風が続くと 90/120/180 秒、失敗すると 30/60/120/300 秒 (最初の失敗はむしろ短くなる)。これに ±10% のジッタ、受信内の待ち行列、rate limit による間隔調整が乗る。全体の件数から平均を出しても個別の間隔は復元できない |
| 内部 GraphQL の生応答がどれだけ容量を食っているか | `/admin/observations/<id>` の `responseText` の長さ と `/admin/metrics` の `tables` | 1 観測あたりのバイト数 × 日次の観測数 × `RAW_RETENTION_DAYS`。`RAW_RETENTION_DAYS` は他に投稿の `raw_result_json`、AutoPush の生フレームと暗号文、`external_exchanges` の応答本文も落とすので、この式で出るのは内部 GraphQL 応答本文ぶんだけ |
| DB 全体がどれだけ増えるか | `/admin/metrics` の `dbBytes` を時間をおいて 2 回 | `dbBytes` は DB 本体と WAL と SHM の合計なので、再起動を挟むと WAL のぶん減ることがある。`delivery_claims` は重複排除の根拠なので保持期間では消さず、長期では増え続ける (経路を削除すれば `ON DELETE CASCADE` で一緒に消える)。全体が定常値に収束するとは限らない |
| どちらの経路が先に投稿を拾ったか | `/admin/deliveries` の `status` と `source` | `sent` の `source` は配信権 (claim) を先に取った側。後から同じ投稿を見つけた側は `skipped_duplicate` になる。もう一方が取りこぼしたことを意味しない。内部 GraphQL の `skipped_duplicate` は、受信アカウントごとに保持期間内の観測で初めて見た投稿でだけ記録し、同じ受信アカウントが同じ投稿を毎周回取り直しても増えない。`sent` と `failed` は再取得時の送信でも記録する |

`/admin/observations` と `/admin/exchanges` は `limit` の既定が 50 なので、分布を見るときは `limit=1000` まで上げる。

## 投稿 1 件をたどる

`/admin/posts/<postId>` は、指定した投稿 ID を Web Push の通知 (`postId` または `notificationPostId` が一致するもの)、キュー、内部 GraphQL の観測から探し、すべての投稿先を、その投稿先でのこの投稿のキュー行と並べて返す。
投稿先を投稿の監視対象で絞らないのは、監視対象が投稿者、リポスト元、会話の文脈など複数の記録から決まり、どれかが保持期間で消えると調べたい投稿先が落ちるためである。
調べたい監視対象の投稿先は `routes[].handle` で選ぶ。
リポストはリポスト自体の ID で配信されるので、元投稿の ID で引いても、通知の `notificationPostId` と、元投稿を URL に持つキュー行からリポストの ID を拾い、`postIds` に並べてその ID でも観測とキューを引く。
通知が保持期間で消え、キュー行も無いリポスト (投稿先の設定で弾かれたもの) は、元投稿の ID からはたどれない。
その場合は `/admin/observations?target=<handle>` の観測を `/admin/observations/<id>` で開き、`referencedPostIdsJson` に元投稿を持つ行の `postId` で引き直す。

| フィールド | 読み方 |
| ---------- | ------ |
| `postIds[]` | 引いた ID と、その ID の Snowflake から復元した `postedAt` |
| `notifications` | 受信した Web Push 通知。空なら Web Push では届いていないか、保持期間で消えているか、復号や解析に失敗して投稿 ID が付かなかった。最後の場合は投稿時刻の前後の `/admin/notifications?kind=malformed` と `kind=other` に行がある |
| `observations.count` と `lastFetchedAt` | `postIds` のどれかに一致した観測投稿の行数と、それを含む観測の最後の取得時刻。投稿は周回ごとに取り直されるので行数は大きくなる |
| `observations.sightings` | 観測投稿の行を古い順に `limit` 件。`isNew` は受信アカウントと監視対象の組での初出 (保持期間内)。`isTargetAuthor` が 0 の行 (他人の投稿や会話モジュールの一部) は配信の対象にならない |
| `routes[].queue` | その投稿先のキュー行。`state` が `sent` なら `discordMessageId` に送ったメッセージがある。`source` は最後にこの行へ投入した経路で、送信に失敗した行を別の経路が投入し直すと書き換わる |
| `routes[].queue[].attempts` | キュー行の投入から最終更新までのうち、投入直後 1 時間と最終更新直前 1 時間の送信履歴 (`sent`、`failed`、`skipped_duplicate`)。最終更新より後に別の経路が記録した `skipped_duplicate` は含まない。あいだの試行は省く。キュー行の `attemptCount` は送信に取りかかった回数で、`skipped_duplicate` を含まず、送信中に停止して結果を記録できなかった回も含む。キュー行の `lastError` は再試行のたびに消えるので、遅れた理由はここで見る |

`attempts` は、キュー行の今の配信元と、この投稿の通知と観測に結びつく履歴だけを拾う。
送信に失敗した行を別の経路が投入し直すと配信元が書き換わるので、元の配信元の通知や観測が保持期間で消えていると、それまでの失敗は `attempts` に出ない。
通知と観測の行 ID は、最も新しい行が消えると次の行に使い回されるので、受信アカウントを削除して作り直した後は、送信に失敗し続けている行の `attempts` に別の投稿の履歴が混ざることがある。

キューが導入される前に送った投稿の行は `discordMessageId` を持たない。
送ったメッセージは、`attempts` に `sent` の行が残っていればその `discordMessageId` で分かる。

キュー行の無い投稿先は、送る前に弾かれたか、どの経路もその投稿を配信対象として見ていない。
弾く条件は次のとおりで、どれも投稿先ごとの記録を残さない。

- `routes[].enabled` が false である。
- `routes[].kinds` が投稿の種別を許していない。内部 GraphQL の種別は観測の `typesJson` で決まる。Web Push は通知の投稿者が監視対象と違えばリポストとし、同じなら投稿 1 件を取得して通常投稿か引用かを決める。その取得に失敗すると通常投稿と引用の両方とみなし、どちらかを許す投稿先には送る。
- `routes[].mediaFilter` が `photo` で、投稿に画像が無いか、画像の有無を判定できなかった。
- 投稿時刻が `routes[].createdAt` より前である。比べる時刻は配信に使った ID のもので、リポストならリポスト自体の時刻になる。内部 GraphQL は観測の `createdAt` を使い、無いときと Web Push では `postIds[].postedAt` を使う。
- 停止中投稿の補完で、観測の `createdAt` が `/admin/backlog` の `notBefore` より前か、`createdAt` が無い。補完のこの判定は投稿 ID の時刻で補わない。

`/admin/metrics` の `delivery.filtered` 系カウンタは、種別とメディアで弾いた件数のうち初出の分だけを数える。
投稿時刻と `enabled` で弾いた分は数えないので、カウンタが増えていないことは弾かれていない証拠にならない。
