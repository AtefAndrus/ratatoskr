---
name: production-investigation
description: Investigates why the deployed ratatoskr bot did or did not relay an X post to Discord, or why relaying looks unhealthy, using the read-only admin API and the code of the running release. Use when given an X post URL or ID reported as "届かなかった", "遅れた", "二重に届いた", or when asked "本番を調べて", "admin api で見て", "受信アカウントは生きてる?", "補完は進んでる?".
---

# 本番調査

読み取りだけで調べる。
Discord への投稿、`/watch` での設定変更、`bun run cli` の `receiver:*` と `env:set` は実行しない。
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
署名と鍵の読み込みは CLI が行い、`ADMIN_API_SECRET` と `ADMIN_BASE_URL` を環境変数、`.env.local`、`.env` の順に読む。
`bun run` は実行するコマンドを標準エラーに 1 行出すので、`jq` には標準出力だけを渡す。
`/admin/logs` だけは JSON ではなくテキストを返す。
宛先の host は `grep -h '^ADMIN_BASE_URL=' .env.local .env` で確かめ、報告に書く。

`curl -s "<ADMIN_BASE_URL>/health"` は認証なしで、動作中の `version`、`startedAt`、受信アカウントごとの AutoPush の接続と最終通知時刻を返す。
起動時刻より前の出来事は、`/admin/logs` (メモリ上の直近 5000 行) にも `/admin/metrics` のカウンタにも残っていない。
DB の行は `RETENTION_DAYS` (既定 30 日) 残り、生応答本文は `RAW_RETENTION_DAYS` (既定 1 日) で消える。

コードを根拠に引くときは、`git fetch --tags` のあと `git diff v<version> HEAD -- <files>` で動作中の版と見比べ、差分があればタグの版を引用する。

## 2. 投稿 1 件をたどる

URL の `/status/` の後ろの数字を投稿 ID として `bun run cli admin /admin/posts/<id>` を叩く。
応答の読み方と、投稿先が投稿を弾く条件は `docs/admin-api.md` の「投稿 1 件をたどる」にある。

投稿先ごとに、次のどれに当たるかを決める。

| 見えたもの | 結論 | 次に見るもの |
| --- | --- | --- |
| `queue[].state` が `sent` | 送った | `discordMessageId`、`attempts` の失敗、報告者が見ているチャンネルとの違い |
| 遅れて届いたという報告 | 拾うのが遅れたか、送るのが遅れた | `postIds[].postedAt`、最初の通知か観測の時刻、`attempts` の最初の試行、`sent` の時刻を並べ、どの区間に時間がかかったかを名指しする |
| `queue[].state` が `pending`、`sending`、`failed` | まだ送れていない | `attempts` の `error`、`/admin/backlog` の `queue`、`/admin/logs?level=warn` |
| 通知か観測はあるがキュー行が無い | 投稿先が弾いた | 文書の弾く条件を投稿先の設定と 1 つずつ照らし、当たった条件を名指しする |
| 通知も観測も無い | どの経路も投稿を見ていない | 手順 3 |
| 通知か観測はあるのに `routes` が空 | 投稿の監視対象が分からない | `/admin/targets`、通知の `targetHandle` が `null` か |
| 二重に届いたという報告 | 投稿先が 2 つあるか、再送した | 別の監視対象の投稿先が同じチャンネルを指して両方 `sent` か (リポスト)。1 つだけなら、Discord が受理した後で DB を更新する前に停止して再送した可能性があり、その送信は記録に残らないので `/health` の `startedAt` と送信時刻を比べる |

`/admin/posts` が 404 を返すのは、動作中の版にまだこのエンドポイントが無いときである。
そのときは `/admin/notifications?limit=1000` と `/admin/observations?target=<handle>&limit=1000` を `jq` で投稿 ID に絞り、照合できなかった範囲を報告に書く。

## 3. 受信側

問いに合わせて `docs/admin-api.md` の「よくある調査」の表から見る場所を選ぶ。
投稿が見えていないときは、少なくとも次を投稿時刻の前後で確かめる。

- 監視対象を担当する受信アカウント (`/admin/metrics` の `receivers[].internalPoll.targets`)。
- その受信アカウントの認証 (`/admin/observations?errors=1` の `responseStatus` と `error`)。同じ受信アカウントが同じ時間帯にほかの対象では成功しているなら、Cookie の失効とは決めず、その対象と受信アカウントの関係 (非公開化、ブロックなど) を疑う。
- 取得の間隔 (`/admin/observations?target=<handle>&limit=1000` の `receiverLabel` ごとの `fetchedAt`)。
- Web Push の受信 (`/health` の `autopushConnected` と `lastNotificationAt`、`/admin/notifications`)。Web Push は全受信アカウントが全対象の通知を受けるので、ある受信アカウントで 1 つの対象の通知だけが止まった理由は管理 API からは分からない。そのときは X 側でその受信アカウントの通知設定を確かめるよう提案する。ある受信アカウントで全対象の通知が止まり、同じころから内部 GraphQL も 401 なら、同じ資格情報の拒否によると推測してよい (推測と明示する)。

Web Push と内部 GraphQL は別々に投稿を拾うので、どちらも見ていないときは経路ごとに落ちた理由を書く。

## 4. 報告

- 確かめた事実 (叩いたエンドポイントと値、コードの `file:line`) と推測を分け、どちらかを明示する。
- 宛先の host と動作中の版を書く。
- 記録が無いことを、起きなかった証拠にしない。保持期間、再起動、弾き条件のどれで記録が無いのかを書き、判断できないなら「判断できない」と書く。
- 届かなかった投稿については (届いた投稿には不要)、直した後に送られるかを次の順に判定して書く。
  1. 投稿がまだ取得ページにあるなら、直した後の次の周回で送られる。内部 GraphQL は毎周回、取得したページにある対象の投稿をすべて配信に回すためである (`src/pipeline/internalPollCollector.ts` の `stored.targetPosts`)。投稿時刻と `observations.lastFetchedAt` の遅いほうより後に、どの受信アカウントのものでも対象の成功した観測があり、そこにその投稿が無ければ、ページから外れている。その時刻より後に成功した観測が無いなら、ページにあるかは判断できない。
  2. ページから外れているなら、通常の取得では送られない。プロセスを再起動すると停止中投稿の補完が走り、その起点は `/admin/backlog` の `progress` にその対象の行があれば最後の正常取得、無ければ DB に残る観測のうち投稿先の作成後で最初の正常取得になる (`src/db/repositories/backlog.ts` の `ensure`)。投稿時刻が起点より後なら、直した後の再起動で送られる見込みがある。その場合、起点より後に弾かれていた同じ対象のほかの投稿も一緒に送られうることも書く。再起動するかは運用者が決めるので、提案にとどめる。
  3. どちらも見込みが立たないなら、手で貼るよう案内する。
- 問いの原因とは別に見つけた異常 (ほかの受信アカウントの認証切れなど) は、原因の説明と混ぜず、別の節に書く。
- 直す手段を、持ち主ごとに提案する。提案だけにとどめ、実行しない。
  - 投稿先の設定: `/watch add` のどのオプションか (オプションは `src/bot/commands/watch.ts` にある。既存の投稿先に `/watch add` し直すと指定した項目だけが変わり、`createdAt` は変わらない)。設定は意図したものかもしれないので、「〜を送りたいなら」の形で書く。
  - 受信アカウントの認証: `bun run cli receiver:update <label>`。
  - Discord のチャンネルや Bot のロールの権限: そのサーバーの管理者。
  - コードの不具合: その箇所。
