# セットアップの詳細

Discord アプリケーションの設定、受信用 X アカウントの登録、ローカルでの起動の詳細をまとめる。
全体の流れは [README の「はじめかた」](../README.md#はじめかた) を参照する。

## Discord アプリケーション

Discord Developer Portal でアプリケーションを作り、次のとおり設定する。
本番用と開発用でアプリケーションを分けると、Token と Slash Command の登録先が混ざらない。

| 項目 | 値 |
| ---- | -- |
| General Information → App Icon | `assets/icon.png` (開発用は `assets/icon-dev.png`) |
| Bot → Banner | `assets/banner.png` (開発用は `assets/banner-dev.png`) |
| Bot → Privileged Gateway Intents | すべて無効 (使うのは `Guilds` intent だけ) |
| Bot → Public Bot | 無効 (自分のサーバーだけで使う場合) |
| Installation → Install Contexts | Guild Install のみ |
| Installation → Default Install Settings → Scopes | `bot`, `applications.commands` |
| Installation → Default Install Settings → Permissions | View Channels, Send Messages, Send Messages in Threads, Embed Links |

`DISCORD_APPLICATION_ID` は General Information の Application ID、`DISCORD_TOKEN` は Bot ページの Reset Token で発行した値である。

上の 4 つの権限を合計した permissions 整数は `274877926400` である。
Embed Links が無いと、送った投稿 URL のプレビューが展開されない。
Send Messages in Threads は、`/watch add` でスレッドを投稿先に選べるようにするために要る。

サーバーへの招待は Installation ページの Install Link を使う。
Slash Command は Bot の起動時にグローバル登録され、初回は Discord 側への反映に最大 1 時間かかることがある。

## ローカル環境の秘密情報

`env:set` は値を非表示入力で受け取り、`.env.local` に権限 0600 で書く。
`.env.local` は git 管理外で、`.env` より優先して読まれる。

```bash
bun run cli env:set DISCORD_TOKEN
bun run cli env:set DISCORD_APPLICATION_ID
bun run cli env:set ADMIN_API_SECRET
```

## 受信用 X アカウント

受信アカウントは監視対象をフォローして通知を受け取る専用のアカウントで、X の利用規約上のリスクを負うため捨てアカウントを使う。

ブラウザで受信アカウントにログインし、開発者ツールの Cookies (`https://x.com`) から次の 2 つの値を控える。
ログアウトすると両方とも失効するので、そのブラウザではログアウトしない。

| Cookie | 形 |
| ------ | -- |
| `auth_token` | 40 桁の 16 進 |
| `ct0` | 160 桁前後の 16 進 |

登録はコマンド引数ではなく、実行後の非表示入力で行う。
ラベルは英小文字、数字、ハイフンで 32 文字以内である。

```bash
bun run cli receiver:add <label>
```

端末が無い環境では環境変数 `X_AUTH_TOKEN` と `X_CT0` から読む。

```bash
X_AUTH_TOKEN='<値>' X_CT0='<値>' bun run cli receiver:add <label> < /dev/null
```

Bot は 1 分ごとに受信アカウントの一覧を読み直し、新しいアカウントには AutoPush の購読を作成して X に登録する。
購読情報と Web Push の秘密鍵は SQLite に保存する。
追加と削除に再起動は要らないが、認証情報の更新だけは再起動が必要である。

```bash
bun run cli receiver:list
bun run cli receiver:update <label>
bun run cli receiver:disable <label>
bun run cli receiver:enable <label>
bun run cli receiver:remove <label>
bun run cli watch:list
```

複数登録すると全アカウントがすべての監視対象をフォローし、どれか 1 つが通知を落としても他が補う。
Discord への送信は経路と投稿の組で重複排除するため、複数アカウントが同じ通知を受けても 1 回しか送らない。
本番とローカルで同じ受信アカウントを使っても、購読は別々に作られるので競合しない。

## 動作の確認

`/health` が 200 を返し、本文の `receivers[].autopushConnected` がすべて `true` なら受信中である。
ログには次の順で出る。

```text
Starting receiver
AutoPush subscription created
Web Push subscription registered with X
AutoPush connected
```

`Receiver provisioning failed` が繰り返し出る場合は Cookie の値が違うか失効している。
`bun run cli receiver:update <label>` で入れ直して再起動する。
