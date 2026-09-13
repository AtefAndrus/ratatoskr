#!/usr/bin/env bash
# release-prepare.sh の結果から、リリースコミットとタグ v<version> を main へ push し、GitHub Release を公開する。
#
# 権限ルールはこのスクリプトの起動だけを許可し、git push 自体は許可していない。
# そのため push するのは「origin の main に、package.json の version と CHANGELOG.md だけを変える 1 コミットを足したもの」に限る。
# 作業ツリーや index を検査してから git commit する形にしないのは、clean filter、hook、ファイルモード、
# origin/main という名前のローカルブランチなどで、検査した内容と実際にコミット・push される内容をずらせるため。
# ここでは blob、tree、commit を plumbing で組み立て、組み立てた object 自体を検証してから、その object ID だけを push する。
set -euo pipefail

readonly repo="AtefAndrus/ratatoskr"
readonly repo_url="https://github.com/$repo.git"

fail() {
  echo "release-publish: $*" >&2
  exit 1
}

# hook は commit や ref 更新のたびに任意の処理を差し込めるので、このスクリプト内の git では常に無効にする
g() {
  git -c core.hooksPath=/dev/null "$@"
}

version="${1:-}"
notes_file="${2:-}"
usage="usage: bun run release:publish <major.minor.patch> [notes-file]"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "$usage"
[ $# -le 2 ] || fail "$usage"
readonly tag="v$version"

if [ -n "$notes_file" ]; then
  [ -f "$notes_file" ] && [ -s "$notes_file" ] || fail "ノートのファイルが無いか空である: $notes_file"
  notes_file=$(realpath "$notes_file")
fi

cd "$(g rev-parse --show-toplevel)"

# insteadOf / pushInsteadOf や pushurl で fetch 先と push 先が別のリポジトリになると、検証の基準がずれる
fetch_urls=$(g remote get-url --all origin)
push_urls=$(g remote get-url --push --all origin)
[ "$fetch_urls" = "$repo_url" ] && [ "$push_urls" = "$repo_url" ] ||
  fail "origin の fetch 先と push 先がどちらも $repo_url だけでない"

remote_ref() {
  local out
  out=$(g ls-remote origin "$1") || fail "origin から $1 を読めない"
  # ls-remote のパターンは末尾一致なので、ref 名の完全一致で絞る
  printf '%s\n' "$out" | awk -F '\t' -v ref="$1" '$2 == ref { print $1 }'
}

create_release() {
  local args=(release create "$tag" -R "$repo" --title "$tag" --generate-notes --verify-tag)
  if [ -n "$notes_file" ]; then
    args+=(--notes-file "$notes_file")
  fi
  gh "${args[@]}"
  gh release view "$tag" -R "$repo" --json url --jq .url
}

# タグが既に origin にあるなら push は終わっている。Release 作成だけが失敗した状態からの再実行として扱い、push はしない。
remote_tag=$(remote_ref "refs/tags/$tag")
if [ -n "$remote_tag" ]; then
  g fetch --quiet --no-tags origin "refs/tags/$tag"
  g cat-file blob "$remote_tag:package.json" | grep -q -F -x "  \"version\": \"$version\"," ||
    fail "origin のタグ $tag は version $version のリリースコミットを指していない"
  echo "origin にタグ $tag があるので push を省き、GitHub Release の作成だけを行う。"
  create_release
  exit 0
fi

[ "$(g symbolic-ref --quiet --short HEAD || true)" = main ] || fail "main 上で実行する"
base=$(remote_ref refs/heads/main)
[ -n "$base" ] || fail "origin に main が無い"
g fetch --quiet --no-tags origin refs/heads/main
[ "$(g rev-parse --verify 'HEAD^{commit}')" = "$base" ] || fail "main が origin の main ($base) と一致しない"
if g rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  fail "ローカルにタグ $tag がある"
fi

stray=$(g status --porcelain=v1 -z --untracked-files=all | tr '\0' '\n' | cut -c4- | grep -v -x -e package.json -e CHANGELOG.md || true)
[ -z "$stray" ] || fail "package.json と CHANGELOG.md 以外に変更がある:
$stray"

# --no-filters で作業ツリーのバイト列をそのまま blob にし、検証は作業ツリーではなくその blob に対して行う
pkg_blob=$(g hash-object -w --no-filters -- package.json)
changelog_blob=$(g hash-object -w --no-filters -- CHANGELOG.md)

g cat-file blob "$base:package.json" |
  sed "s/^  \"version\": \"[^\"]*\",\$/  \"version\": \"$version\",/" |
  cmp -s - <(g cat-file blob "$pkg_blob") ||
  fail "package.json の変更が version を $version にするだけではない"

first_heading=$(g cat-file blob "$changelog_blob" | grep -m1 '^## \[' || true)
[[ "$first_heading" == "## [$version] - "* ]] || fail "CHANGELOG.md の先頭見出しが $version でない: $first_heading"

tmp_index=$(mktemp)
trap 'rm -f "$tmp_index"' EXIT
GIT_INDEX_FILE="$tmp_index" g read-tree "$base"
GIT_INDEX_FILE="$tmp_index" g update-index --cacheinfo "100644,$pkg_blob,package.json"
GIT_INDEX_FILE="$tmp_index" g update-index --cacheinfo "100644,$changelog_blob,CHANGELOG.md"
tree=$(GIT_INDEX_FILE="$tmp_index" g write-tree)

# 組み立てた tree が基準から 2 ファイルの内容変更だけであることを、モードを含めて確かめる
expected_diff=$(printf ':100644 100644 %s %s M\tCHANGELOG.md\n:100644 100644 %s %s M\tpackage.json' \
  "$(g rev-parse "$base:CHANGELOG.md")" "$changelog_blob" "$(g rev-parse "$base:package.json")" "$pkg_blob")
[ "$(g diff-tree -r --no-renames --no-ext-diff "$base" "$tree")" = "$expected_diff" ] ||
  fail "組み立てた tree が package.json と CHANGELOG.md の内容変更だけになっていない"

commit=$(g commit-tree "$tree" -p "$base" -m "[chore] bump version to $tag")
[ "$(g rev-list --parents -n 1 "$commit")" = "$commit $base" ] || fail "リリースコミットの親が $base だけでない"

# --no-follow-tags: push.followTags が有効でも、明示した 2 つの ref 以外を送らない
push_status=0
g push --atomic --no-follow-tags --no-verify origin "$commit:refs/heads/main" "$commit:refs/tags/$tag" || push_status=$?

# push の終了コードは remote の状態を決めないので、remote を読み直して判断する
remote_main=$(remote_ref refs/heads/main)
remote_tag=$(remote_ref "refs/tags/$tag")
if [ "$remote_main" != "$commit" ] || [ "$remote_tag" != "$commit" ]; then
  if [ "$remote_tag" = "" ] && [ "$remote_main" = "$base" ]; then
    fail "push が反映されなかった (終了コード $push_status)。ローカルの ref は変えていないので、原因を解消して同じコマンドを再実行できる"
  fi
  fail "push 後の origin が想定と違う (main=$remote_main, $tag=${remote_tag:-なし}, 期待=$commit)。手で確認する"
fi

g update-ref -m "release $tag" refs/heads/main "$commit" "$base"
g tag "$tag" "$commit"
# 作業ツリーは既にリリースコミットの内容なので、index だけを揃える
g reset --quiet
g fetch --quiet --no-tags origin refs/heads/main

create_release
