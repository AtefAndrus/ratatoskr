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

`source` の値は `x_push_registration`、`x_target_notifications`、`x_internal_api_document`、`x_transaction_pairs` である。

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

## curl 例

```bash
SECRET="$ADMIN_API_SECRET"
BASE="http://localhost:3000"

admin() {
  local path="$1" query="${2:-}"
  local ts; ts=$(date +%s%3N)
  local sig; sig=$(printf 'GET\n%s\n%s\n%s' "$path" "$query" "$ts" \
    | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
  curl -sS "$BASE$path${query:+?$query}" \
    -H "X-Admin-Timestamp: $ts" -H "X-Admin-Signature: sha256=$sig"
}

admin /admin/metrics | jq .
admin /admin/observations "errors=1&limit=20" | jq .
admin /admin/observations/123 | jq -r .responseText | head -c 2000
admin /admin/logs "level=warn&lines=100"
```

複数のクエリを渡すときは `key` 昇順に並べてから署名する。
