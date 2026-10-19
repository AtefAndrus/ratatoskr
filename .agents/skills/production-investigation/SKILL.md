---
name: production-investigation
description: Investigates why the deployed ratatoskr bot did or did not relay an X post to Discord, or why relaying looks unhealthy, using the read-only admin API and the code of the running release. Use when given an X post URL or ID reported as "届かなかった", "遅れた", "二重に届いた", or when asked "本番を調べて", "admin api で見て", "受信アカウントは生きてる?", "補完は進んでる?".
---

# 本番調査

読み取りだけで調べる。
Discord への投稿、`/watch` での設定変更、`bun run cli` の `receiver:*` と `env:set`、プロセスの再起動は実行しない。
`ADMIN_API_SECRET`、X の Cookie、Discord Token を出力に出さない。

次のチェックリストを写して進める。

```text
- [ ] 1. 宛先と動作中の版を確かめる
- [ ] 2. 投稿 1 件をたどる (投稿についての問いのとき)
- [ ] 3. 受信側を調べる (どの経路も投稿を見ていないとき、または全体の不調の問い)
- [ ] 4. 確かめた事実と推測を分けて報告する
```

## 1. 宛先と動作中の版

管理 API はリポジトリのルートで `bun run cli admin <path> [query]` を使って叩く (例: `bun run cli admin /admin/observations "target=beta_lab&limit=1000"`)。
署名と鍵の読み込みは CLI が行う。
`bun run` は実行するコマンドを標準エラーに 1 行出すので、`jq` には標準出力だけを渡す。
`/admin/logs` だけは JSON ではなくテキストを返す。
DB を読むエンドポイント (`/admin/logs` 以外) は同時に 1 件しか実行されず、実行中に叩いた分は `HTTP 503` で失敗するので、並行して叩かず 1 件ずつ順に叩く。
`503` の間は 5 秒おきに叩き直す。先に動いている読み取りは最長 20 秒で終わる。

宛先は、空でない環境変数 `ADMIN_BASE_URL`、`.env.local`、`.env` の順に最初に見つかった値で、どれにも無ければ `http://localhost:3000` になる (`src/config/index.ts` の `loadEnvFile`、`src/http/adminClient.ts`)。
CLI と同じ読み込みで host だけを出し、報告に書く。

```bash
bun -e 'import { loadEnvFile } from "./src/config"; loadEnvFile(); console.log(new URL(process.env.ADMIN_BASE_URL || "http://localhost:3000").host)'
```

`curl -s "<宛先>/health"` は認証なしで、動作中の `version`、HTTP サーバーの起動時刻 `startedAt`、受信アカウントごとの AutoPush の接続と最終通知時刻を返す。
前回のプロセスの出来事は、`/admin/logs` (メモリ上の直近 5000 行) にも `/admin/metrics` のカウンタにも残っていない。
通知、観測、送信履歴の行は `RETENTION_DAYS` (既定 30 日) で消え、生応答本文は `RAW_RETENTION_DAYS` (既定 1 日) で消える。
キュー行、`delivery_claims`、補完の進捗は保持期間では消えない。

コードを根拠に引くときは、`git fetch --tags` のあと `git diff v<version> -- <files>` で動作中の版と作業ツリーを見比べ、差分があればタグの版 (`git show v<version>:<file>`) を引用する。

## 2. 投稿 1 件をたどる

URL の `/status/` の後ろの数字を投稿 ID として `bun run cli admin /admin/posts/<id> "limit=1000"` を叩く。
観測の行は全監視対象をまとめて古い順に `limit` 件だけ返る。
`observations.count` が `sightings` の件数より多いときは、調べたい対象の観測が欠けている可能性があるので、`/admin/observations?target=<handle>&limit=1000` から投稿時刻より後の観測を選び、`/admin/observations/<id>` の `posts` で補う。補いきれなければ、その対象が見ていたかは判断できないと書く。
応答の読み方と、投稿先が投稿を弾く条件は `docs/admin-api.md` の「投稿 1 件をたどる」にある。
`routes` はすべての投稿先を返すので、`routes[].handle` で調べたい監視対象の投稿先を選ぶ。

その投稿の監視対象が見ていたかは、`targetHandle` がその対象の通知か、`isTargetAuthor` が 1 でその対象の観測があるかで決める。
他人の投稿や会話の文脈として観測に出ただけの行 (`isTargetAuthor` が 0) は、配信の対象になっていない。

投稿先ごとに、次のどれに当たるかを決める。

| 見えたもの | 結論 | 次に見るもの |
| --- | --- | --- |
| `queue[].state` が `sent` | 送った | `discordMessageId`、`attempts` の失敗、報告者が見ているチャンネルとの違い |
| 遅れて届いたという報告 | 拾うのが遅れたか、送るのが遅れた | `postIds[].postedAt`、最初の通知か観測の時刻、`attempts` の最初の試行、`sent` の時刻を並べ、どの区間に時間がかかったかを名指しする |
| `queue[].state` が `pending`、`sending`、`failed` | 送信の成功が DB に確定していない (Discord が受理したのに応答を受け取れなかった場合もこの形になる) | `attempts` の `error`、`/admin/backlog` の `queue`、`/admin/logs?level=warn` |
| 監視対象が見ていたのに、その投稿先にキュー行が無い | 投稿先が弾いたことが多い。ほかに、投入の前の追加取得 (種別や画像の判定) を待っている途中か、観測の保存とキューへの投入のあいだでプロセスが止まった場合もこの形になる | 文書の弾く条件を投稿先の設定と 1 つずつ照らし、当たった条件を名指しする。`routes` は今の設定を返すので、投稿の後に設定を変えた可能性があるなら「今の設定では弾く」として候補にとどめる。どれにも当たらなければ、少し後に引き直して変わるかと、観測の時刻の直後に `/health` の `startedAt` が来ていないかを見る |
| 監視対象が見ていない | どの経路も配信の対象として見ていない | 通知の `targetHandle` が `null` なら監視対象を決められなかった。そうでなければ手順 3 |
| 二重に届いたという報告 | 投稿先が 2 つあるか、同じ投稿が別の ID でキューに入ったか、再送した | 別の監視対象の投稿先が同じチャンネルを指して両方 `sent` か (リポスト)。リポストなら元投稿の ID で引き直す (リポスト自体の ID からは、元投稿の ID で投入された行が見つからない)。同じ投稿先に `postId` の違う `sent` のキュー行が 2 つあれば、同じ投稿が別の ID で投入された (リポストの通知が自身の ID を持たない場合など)。どの通知や観測から投入されたかは `queue[].source` と `notifications`、`observations` で照らす。1 つだけなら再送を疑う。`attempts` の `failed` の後の `sent` (受理されたのに応答を受け取れなかった送信の再試行) や、`/health` の `startedAt` の前後の送信 (受理後に DB を更新する前の停止) が手がかりになる。ただし Discord への要求を送信ライブラリが内部で再試行した分は記録に残らないので、手がかりが無くても再送でないとは決めない |

`/admin/posts` が 404 を返すのは、動作中の版にまだこのエンドポイントが無いときである。
そのときは `/admin/notifications?limit=1000` を投稿 ID (`postId` か `notificationPostId`) で絞る。
観測の一覧は投稿 ID を持たないので、`/admin/observations?target=<handle>&limit=1000` から投稿時刻より後の観測を選び、`/admin/observations/<id>` の `posts` で投稿 ID を照合する。
照合できなかった範囲は報告に書く。

## 3. 受信側

問いに合わせて `docs/admin-api.md` の「よくある調査」の表から見る場所を選ぶ。
投稿が見えていないときは、少なくとも次を投稿時刻の前後で確かめる。

- 監視対象を担当する受信アカウント (`/admin/metrics` の `receivers[].internalPoll.targets`)。
- その受信アカウントの認証 (`/admin/observations?errors=1` の `responseStatus` と `error`)。同じ受信アカウントが同じ時間帯にほかの対象では成功しているなら、Cookie の失効とは決めず、その対象と受信アカウントの関係 (非公開化、ブロックなど) を疑う。
- 取得の間隔 (`/admin/observations?target=<handle>&limit=1000` の `receiverLabel` ごとの `fetchedAt`)。
- Web Push の受信 (`/health` の `autopushConnected` と `lastNotificationAt`、`/admin/notifications`)。Web Push は全受信アカウントが全対象の通知を受けるので、ある受信アカウントで 1 つの対象の通知だけが止まったときの手がかりには、`/admin/logs` のその受信アカウントとその対象の `Target configuration failed`、`/admin/notifications` の `kind=malformed` と `kind=other` の行、`targetHandle` が `null` の行 (監視対象を特定できなかった通知) がある。手がかりから理由を決められなければ、X 側でその受信アカウントの通知設定を確かめるよう提案する。ある受信アカウントで全対象の通知が止まり、同じころから内部 GraphQL も 401 なら、同じ資格情報の拒否によると推測してよい (推測と明示する)。

Web Push と内部 GraphQL は別々に投稿を拾うので、どちらも見ていないときは経路ごとに落ちた理由を書く。

## 4. 報告

- 確かめた事実 (叩いたエンドポイントと値、コードの `file:line`) と推測を分け、どちらかを明示する。
- 宛先の host と動作中の版を書く。
- 記録が無いことを、起きなかった証拠にしない。保持期間、前回のプロセス、弾き条件のどれで記録が無いのかを書き、判断できないなら「判断できない」と書く。
- 届かなかった投稿については (届いた投稿には不要)、直した後に送られるかを次の順に判定して書く。
  1. その投稿先のキュー行が `pending` か `failed` で、投稿先が有効 (`enabled`) なら、取得の状況に関係なく再試行で送られる。バックグラウンドの再試行はキューを一巡処理し終えてから 30 秒待って次の一巡を始める形なので、滞留が多ければ 1 件の再試行まで数分以上かかる。同じ投稿をどちらかの経路が再検出すると、`failed` の行は待たずに投入し直されて送られる (`src/services/deliveryService.ts` の `run`、`src/db/repositories/deliveries.ts` の `listReadyIds`)。`sending` は送信中で、その試行の結果を待つ。どちらも原因を直せば送られるので、手で貼るよう案内しない。
  2. キュー行が無いなら、自動で送られるかは管理 API からは判断できないと書く。取得ページに残っていれば後の周回で、外れていても停止中投稿の補完で送られることがあり、いつ送られるかも決まらない。手で貼ると、後から自動でも届いて二重になりうることを添え、貼るかは報告者に任せる。
- 問いの原因とは別に見つけた異常 (ほかの受信アカウントの認証切れなど) は、原因の説明と混ぜず、別の節に書く。
- 直す手段を、持ち主ごとに提案する。提案だけにとどめ、実行しない。
  - 投稿先の設定: `/watch add` のどのオプションか (オプションは `src/bot/commands/watch.ts` にある)。既存の投稿先に `/watch add` し直すと、指定した項目が変わり、投稿先が有効になり、`createdAt` は変わらない。設定は意図したものかもしれないので、「〜を送りたいなら」の形で書く。
  - 受信アカウントの認証: `bun run cli receiver:update <label>`。
  - Discord のチャンネルや Bot のロールの権限: そのサーバーの管理者。
  - コードの不具合: その箇所。
