#!/usr/bin/env bash
# デプロイの前後で本番の /health を読み、新しい版のプロセスに切り替わったことを確かめる。
#
#   wait-for-deploy.sh --snapshot <health-url>
#     デプロイを起こす直前のサーバーの時刻 (/health の now) を出力する。版を返さない旧版の /health なら空行を出力する。
#     どちらも読めないまま試行を使い切ったら失敗で終わる。
#   wait-for-deploy.sh <health-url> <expected-version> <baseline>
#     /health が、待つ版で起動時刻が <baseline> より後のプロセスだけを返し続け、Coolify のロールバック判定を越えて
#     正常に動いていることを確かめるまで待つ。<baseline> が空なら、起動時刻を返すプロセスをすべて新しいとみなす
#     (デプロイ前の版が起動時刻を返さなかったので、返すプロセスはデプロイ後に起動している)。期限を過ぎたら失敗で終わる。
#
# Coolify のデプロイ API の成功は、デプロイ要求を受け付けたことしか示さない。Coolify はヘルスチェックが通らないと
# 旧コンテナへ戻すので、本番で動いているプロセスを直接見る。版の一致だけで判定しないのは、同じ版を出し直したときに
# 旧コンテナの応答でも一致するため。
# 新旧は「デプロイ前に読んだサーバーの時刻より後に起動したか」で見分け、「デプロイ前に応答したプロセスと起動時刻が
# 違うか」では見分けない。前のデプロイと重なると、デプロイ前に応答するのがその候補で、ロールバックで残った元の
# プロセスを違うプロセスとして受け入れてしまうため。比べる 2 つの時刻はどちらもサーバーの時計で、ランナーの時計や
# 応答の遅れは判定に入らない。サーバーの値は形式を確かめてから文字列として比べ、Bash の算術には渡さない。
set -euo pipefail
# 時刻の文字列比較をロケールの照合順序に左右させない
export LC_ALL=C

usage() {
  echo "usage: $0 --snapshot <health-url>" >&2
  echo "       $0 <health-url> <expected-version> <baseline>" >&2
  exit 2
}

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null; then
    echo "wait-for-deploy: $tool が見つからない" >&2
    exit 2
  fi
done

interval_seconds=${INTERVAL_SECONDS:-10}
# Date.prototype.toISOString の形。この形どうしなら文字列の順序が時刻の順序と一致する
iso_time='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'

# /health を 1 回読み、status (HTTP 状態)、version、started_at、now、readable (本文を JSON として読めたか)、
# legacy_health (本文が version と now を持たない旧版の /health の形か) を設定する。started_at と now は形式が合わなければ空にする。
read_health() {
  local response parsed
  status=""
  version=""
  started_at=""
  now=""
  legacy_health=false
  readable=false
  # 503 (Discord 未接続) の本文にも版と起動時刻が載るので、状態コードでは捨てない
  response=$(curl --silent --show-error --max-time 10 --write-out '\n%{http_code}' "$1" 2>/dev/null) || return 0
  status=${response##*$'\n'}
  if parsed=$(printf '%s' "${response%$'\n'*}" |
    jq -er 'select(type == "object") |
      [(.version // ""), (.startedAt // ""), (.now // ""),
        ((.status | type) == "string" and (.discord | type) == "object" and (.uptime | type) == "number" and
          (has("version") | not) and (has("now") | not))] |
      map(tostring) | @tsv' 2>/dev/null); then
    readable=true
    # read は空の欄を詰めてしまうので、タブで順に切り出す
    version=${parsed%%$'\t'*}
    parsed=${parsed#*$'\t'}
    started_at=${parsed%%$'\t'*}
    parsed=${parsed#*$'\t'}
    now=${parsed%%$'\t'*}
    legacy_health=${parsed#*$'\t'}
    [[ $started_at =~ $iso_time ]] || started_at=""
    [[ $now =~ $iso_time ]] || now=""
  fi
}

if [ "${1:-}" = --snapshot ]; then
  [ "$#" -eq 2 ] || usage
  for _ in 1 2 3; do
    read_health "$2"
    if [ -n "$now" ]; then
      printf '%s\n' "$now"
      exit 0
    fi
    # 空の基準はどのプロセスも新しいとみなすので、版を返さない旧版の /health の形に限る。proxy のエラー本文や
    # now を欠いた応答を旧版と取り違えると、同じ版の出し直しで動き続けている旧プロセスを成功にする
    if [ "$legacy_health" = true ]; then
      echo
      exit 0
    fi
    sleep "$interval_seconds"
  done
  echo "wait-for-deploy: デプロイ前の /health からサーバーの時刻を読めなかった (HTTP ${status:-なし})。新旧のプロセスを見分けられない" >&2
  exit 1
fi

[ "$#" -eq 3 ] || usage
health_url=$1
expected_version=$2
baseline=$3
if [ -n "$baseline" ] && ! [[ $baseline =~ $iso_time ]]; then
  echo "wait-for-deploy: 基準の時刻の形式が違う: $baseline" >&2
  exit 2
fi

timeout_seconds=${TIMEOUT_SECONDS:-1500}
# 2026-10-13 の失敗では、Coolify は新しいコンテナの起動から約 105 秒で旧コンテナへ戻した
stable_seconds=${STABLE_SECONDS:-180}

deadline=$(($(date +%s) + timeout_seconds))
# 新しいプロセスだけを観測し続けている区間の、起動時刻と始まり (ランナーの時計)
streak_started_at=""
streak_since=""
last_seen="応答なし"

while :; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "wait-for-deploy: ${timeout_seconds} 秒以内に v${expected_version} の新しいプロセスが安定しなかった (最後の観測: ${last_seen})" >&2
    exit 1
  fi

  read_health "$health_url"
  observed_at=$(date +%s)
  # 期限の直前に始めた読み取りが期限後に返った応答では、成功にしない
  [ "$observed_at" -lt "$deadline" ] || continue

  if [ "$version" = "$expected_version" ] && [ -n "$started_at" ] && [[ $started_at > $baseline ]]; then
    last_seen="v${version} (起動 ${started_at})、HTTP ${status}"
    if [ "$started_at" != "$streak_started_at" ]; then
      streak_started_at=$started_at
      streak_since=$observed_at
      echo "wait-for-deploy: v${version} の新しいプロセス (起動 ${started_at}) を観測した。${stable_seconds} 秒続くまで待つ"
    elif [ "$status" = 200 ] && [ $((observed_at - streak_since)) -ge "$stable_seconds" ]; then
      echo "wait-for-deploy: v${version} の新しいプロセスだけを ${stable_seconds} 秒以上観測し、正常に応答している。デプロイは完了した"
      exit 0
    fi
  else
    # 旧プロセスの応答や読めない応答を挟んだら、新しいプロセスだけが動いているとは言えないので待ち直す
    if [ "$readable" = true ]; then
      last_seen="v${version:-不明} (起動 ${started_at:-不明})、HTTP ${status}"
    else
      last_seen="読めない応答 (HTTP ${status:-なし})"
    fi
    streak_started_at=""
    streak_since=""
  fi

  sleep "$interval_seconds"
done
