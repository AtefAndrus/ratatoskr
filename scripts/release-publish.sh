#!/usr/bin/env bash
# release-prepare.sh の結果をコミットし、タグと main を push して GitHub Release を公開する。
# main へ直接 push できるのはこのスクリプトだけという前提で権限ルールを許可しているので、
# push する内容を「origin/main に package.json と CHANGELOG.md の版上げ 1 コミットを足したもの」に限る検証を緩めない。
set -euo pipefail

fail() {
  echo "release-publish: $*" >&2
  exit 1
}

version="${1:-}"
notes_file="${2:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "usage: bun run release:publish <major.minor.patch> [notes-file]"
[ $# -le 2 ] || fail "usage: bun run release:publish <major.minor.patch> [notes-file]"
tag="v$version"

if [ -n "$notes_file" ]; then
  [ -s "$notes_file" ] || fail "ノートのファイルが無いか空である: $notes_file"
  notes_file=$(realpath "$notes_file")
fi

cd "$(git rev-parse --show-toplevel)"

[ "$(git symbolic-ref --quiet --short HEAD || true)" = main ] || fail "main 上で実行する"
git fetch --quiet --tags origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main が origin/main と一致しない"
if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  fail "タグ $tag が既にある"
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  fail "origin にタグ $tag が既にある"
fi

changed=$(git status --porcelain --untracked-files=all | sort)
expected=$(printf ' M CHANGELOG.md\n M package.json' | sort)
[ "$changed" = "$expected" ] || fail "変更が package.json と CHANGELOG.md だけではない:
$changed"

git show HEAD:package.json | sed "s/^  \"version\": \"[^\"]*\",\$/  \"version\": \"$version\",/" | cmp -s - package.json ||
  fail "package.json の変更が version を $version にするだけではない"
grep -q -m1 "^## \[$version\] - " CHANGELOG.md || fail "CHANGELOG.md に $version の見出しが無い"
[ "$(grep -m1 '^## \[' CHANGELOG.md)" = "$(grep -m1 "^## \[$version\] - " CHANGELOG.md)" ] || fail "CHANGELOG.md の先頭見出しが $version でない"

# pre-commit のブランチガードは main への直コミットを止めるが、リリースコミットは意図して main に作る。
# 検査は release-prepare.sh の bun run check で済んでおり、ここで変わるのは版の文字列だけである。
LEFTHOOK=0 git commit --quiet -m "[chore] bump version to $tag" -- package.json CHANGELOG.md
git tag "$tag"

# --atomic により main とタグは両方更新されるか、どちらも更新されない。force push はしない。
if ! git push --atomic origin "refs/heads/main:refs/heads/main" "refs/tags/$tag:refs/tags/$tag"; then
  echo "release-publish: push に失敗した。ローカルにリリースコミットとタグ $tag が残っている。" >&2
  echo "やり直すときは git tag -d $tag && git reset --soft origin/main で戻す。" >&2
  exit 1
fi

release_args=(release create "$tag" --title "$tag" --generate-notes --verify-tag)
if [ -n "$notes_file" ]; then
  release_args+=(--notes-file "$notes_file")
fi
gh "${release_args[@]}"

gh release view "$tag" --json url --jq .url
