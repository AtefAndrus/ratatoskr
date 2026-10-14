#!/usr/bin/env bash
# デプロイの前後で本番の /health を読み、新しい版のプロセスに切り替わったことを確かめる。
#
#   wait-for-deploy.sh --snapshot <health-url>
#     デプロイを起こす直前に動いているプロセスの startedAt を出力する。startedAt を返さない版 (応答は読める) なら
#     空行を出力する。応答を読めないまま試行を使い切ったら失敗で終わる。
#   wait-for-deploy.sh <health-url> <expected-version> <previous-started-at>
#     /health が、待つ版で起動時刻が <previous-started-at> と違うプロセスだけを返し続け、Coolify のロールバック判定を
#     越えて正常に動いていることを確かめるまで待つ。期限を過ぎたら失敗で終わる。
#
# Coolify のデプロイ API の成功は、デプロイ要求を受け付けたことしか示さない。Coolify はヘルスチェックが通らないと
# 旧コンテナへ戻すので、本番で動いているプロセスを直接見る。版の一致だけで判定しないのは、同じ版を出し直したときに
# 旧コンテナの応答でも一致するため。プロセスはサーバーが返す起動時刻の文字列で見分け、時刻の計算には使わない。
# 応答の遅れやランナーとサーバーの時計のずれに判定を左右させないためである。
set -euo pipefail

usage() {
  echo "usage: $0 --snapshot <health-url>" >&2
  echo "       $0 <health-url> <expected-version> <previous-started-at>" >&2
  exit 2
}

interval_seconds=${INTERVAL_SECONDS:-10}

# /health を 1 回読み、status (HTTP 状態)、version、started_at、readable (本文を JSON として読めたか) を設定する。
read_health() {
  local response parsed
  status=""
  version=""
  started_at=""
  readable=false
  # 503 (Discord 未接続) の本文にも版と起動時刻が載るので、状態コードでは捨てない
  response=$(curl --silent --show-error --max-time 10 --write-out '\n%{http_code}' "$1" 2>/dev/null) || return 0
  status=${response##*$'\n'}
  if parsed=$(printf '%s' "${response%$'\n'*}" |
    jq -er 'select(type == "object") | [(.version // ""), (.startedAt // "")] | @tsv' 2>/dev/null); then
    readable=true
    version=${parsed%%$'\t'*}
    started_at=${parsed#*$'\t'}
  fi
}

if [ "${1:-}" = --snapshot ]; then
  [ "$#" -eq 2 ] || usage
  for _ in 1 2 3; do
    read_health "$2"
    if [ "$readable" = true ]; then
      printf '%s\n' "$started_at"
      exit 0
    fi
    sleep "$interval_seconds"
  done
  echo "wait-for-deploy: デプロイ前の /health を読めなかった (HTTP ${status:-なし})。新旧のプロセスを見分けられない" >&2
  exit 1
fi

[ "$#" -eq 3 ] || usage
health_url=$1
expected_version=$2
previous_started_at=$3

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

  if [ "$version" = "$expected_version" ] && [ -n "$started_at" ] &&
    [ "$started_at" != "$previous_started_at" ]; then
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
