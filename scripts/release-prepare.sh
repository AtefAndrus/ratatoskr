#!/usr/bin/env bash
# package.json の version と CHANGELOG.md を対象バージョンへ更新する。コミット以降は release-publish.sh が行う。
set -euo pipefail

fail() {
  echo "release-prepare: $*" >&2
  exit 1
}

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "usage: bun run release:prepare <major.minor.patch>"
tag="v$version"

cd "$(git rev-parse --show-toplevel)"

[ "$(git symbolic-ref --quiet --short HEAD || true)" = main ] || fail "main 上で実行する"
[ -z "$(git status --porcelain)" ] || fail "作業ツリーがクリーンでない"
git fetch --quiet --tags origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)" ] || fail "main が origin/main と一致しない"
if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  fail "タグ $tag が既にある"
fi
# ファイルを書き換える前に比較の基準を決め、ここで失敗しても作業ツリーを汚さない
prev=$(git describe --tags --abbrev=0) || fail "HEAD から辿れるリリースタグが無い (shallow clone なら git fetch --unshallow する)"

bun run check

bun pm pkg set "version=$version" >/dev/null
# シェルの PATH に別の版の git-cliff が残っていても mise.toml で固定した版を使う
mise exec -- git-cliff --tag "$tag" --output CHANGELOG.md

first_heading=$(grep -m1 '^## ' CHANGELOG.md || true)
[[ "$first_heading" == "## [$version] - "* ]] || fail "CHANGELOG の先頭見出しが想定と違う: $first_heading"

echo
echo "== $prev 以降で移行とデプロイ後の確認に関わる差分"
git --no-pager diff --stat "$prev" HEAD -- src/db/schema.ts src/config/ Dockerfile docs/deployment.md
echo
echo "== 次の手順"
echo "git diff で package.json と CHANGELOG.md を確認し、必要ならノートの節を書いてから次を実行する。"
echo "/bin/bash $(pwd -P)/scripts/release-publish.sh $version [notes-file]"
