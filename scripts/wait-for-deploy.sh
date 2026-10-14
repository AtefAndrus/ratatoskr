#!/usr/bin/env bash
# デプロイを起こした後に、/health が新しい版のプロセスを返し、そのプロセスが Coolify のロールバック判定を越えて
# 動き続けるまで待つ。新しいプロセスに切り替わらないまま期限を過ぎたら失敗で終わる。
#
#   wait-for-deploy.sh <health-url> <expected-version> <triggered-at-epoch-seconds>
#
# Coolify のデプロイ API の成功は、デプロイ要求を受け付けたことしか示さない。Coolify はヘルスチェックが通らないと
# 旧コンテナへ戻すので、本番で動いているプロセスを直接見る。版の一致だけで判定しないのは、同じ版を出し直したときに
# 旧コンテナの応答でも一致するため。プロセスの起動時刻 (応答を受けた時刻 - uptime) がデプロイを起こした後であることも見る。
set -euo pipefail

usage() {
  echo "usage: $0 <health-url> <expected-version> <triggered-at-epoch-seconds>" >&2
  exit 2
}

[ "$#" -eq 3 ] || usage
health_url=$1
expected_version=$2
triggered_at=$3
[[ "$triggered_at" =~ ^[0-9]+$ ]] || usage

timeout_seconds=${TIMEOUT_SECONDS:-900}
# 2026-10-13 の失敗では、Coolify は新しいコンテナの起動から約 105 秒で旧コンテナへ戻した
stable_seconds=${STABLE_SECONDS:-180}
interval_seconds=${INTERVAL_SECONDS:-10}
# 応答の遅れと秒の切り捨てで、起動時刻の推定が前後する幅
start_tolerance_seconds=5

deadline=$((triggered_at + timeout_seconds))
candidate_start=""
last_seen="応答なし"

while :; do
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    echo "wait-for-deploy: ${timeout_seconds} 秒以内に v${expected_version} の新しいプロセスが安定しなかった (最後の観測: ${last_seen})" >&2
    exit 1
  fi

  # 503 (Discord 未接続) の本文にも版と uptime が載るので、状態コードでは捨てない
  if body=$(curl --silent --show-error --max-time 10 "$health_url" 2>/dev/null) &&
    parsed=$(printf '%s' "$body" | jq -er '[.version, .uptime] | @tsv' 2>/dev/null); then
    observed_at=$(date +%s)
    version=${parsed%%$'\t'*}
    uptime=${parsed#*$'\t'}
    process_start=$((observed_at - uptime))
    last_seen="v${version}、uptime ${uptime} 秒"

    if [ "$version" = "$expected_version" ] &&
      [ "$process_start" -ge $((triggered_at - start_tolerance_seconds)) ]; then
      if [ -z "$candidate_start" ] ||
        [ "$process_start" -gt $((candidate_start + start_tolerance_seconds)) ] ||
        [ "$process_start" -lt $((candidate_start - start_tolerance_seconds)) ]; then
        candidate_start=$process_start
        echo "wait-for-deploy: v${version} の新しいプロセスを観測した (uptime ${uptime} 秒)。${stable_seconds} 秒続くまで待つ"
      elif [ $((observed_at - candidate_start)) -ge "$stable_seconds" ]; then
        echo "wait-for-deploy: v${version} のプロセスが ${uptime} 秒動き続けている。デプロイは完了した"
        exit 0
      fi
    else
      # 旧コンテナへ戻されたか、まだ切り替わっていない
      candidate_start=""
    fi
  else
    last_seen="応答を読めなかった"
  fi

  sleep "$interval_seconds"
done
