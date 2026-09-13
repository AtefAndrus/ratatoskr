#!/usr/bin/env bash
# release-prepare.sh が書き換えた package.json と CHANGELOG.md から、リリースコミットとタグ v<version> を
# GitHub の main へ push し、GitHub Release を公開する。
#
# 権限ルールはこのスクリプトの起動だけを許可し、git push 自体は許可していない。
# そのため push するのは「GitHub の main に、package.json の version と CHANGELOG.md だけを変える 1 コミットを足したもの」に限る。
#
# 作業中のリポジトリで検査してから commit / push する形にしないのは、そのリポジトリの設定と状態
# (clean filter、hook、replace refs、core.fsmonitor、remote の pushurl や vcs helper、origin/main という名前のブランチなど)
# で、検査した内容と push される内容をずらしたり、push 以外のコマンドを実行させたりできるため。
# 作業ツリーからは 2 ファイルのバイト列だけを読み、GIT_* 環境変数を外した一時 bare リポジトリで
# GitHub の main を取得し、blob、tree、commit を組み立てて検証し、その object ID だけを push する。
# ~/.gitconfig は認証ヘルパーのために読む。利用者自身の設定であり、リポジトリの状態とは別に信頼する。
#
# 権限ルールは bun run ではなく /bin/bash とこのファイルの絶対パスで許可する。
# bun run は package.json の scripts から実行内容を決め、PATH の先頭に node_modules/.bin を足すので、
# どちらもリポジトリ内のファイルで差し替えられるため。
set -euo pipefail

# 外部コマンドを呼ぶ前に、リポジトリ内から持ち込める実行ファイルを外す。
# PATH のうち相対パス、このリポジトリ配下 (node_modules/.bin など)、mise の管理ディレクトリ
# (リポジトリの mise.toml が tools や env._.path で足せる) を除き、環境から取り込んだ関数も消す。
# ここより上では bash の組み込みコマンドだけを使う。
while read -r _ _ fn; do
  unset -f "$fn"
done < <(declare -F)
script_dir="${BASH_SOURCE[0]%/*}"
[ "$script_dir" != "${BASH_SOURCE[0]}" ] || script_dir=.
repo_root=$(cd "$script_dir/.." && pwd -P)
repo_root_logical=$(cd "$script_dir/.." && pwd -L)
mise_data="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}"
trusted_path=
IFS=: read -r -a path_entries <<<"$PATH"
for entry in "${path_entries[@]}"; do
  case "$entry" in
    /*) ;;
    *) continue ;;
  esac
  case "$entry/" in
    "$repo_root"/* | "$repo_root_logical"/* | "$mise_data"/*) continue ;;
  esac
  trusted_path="${trusted_path:+$trusted_path:}$entry"
done
export PATH="$trusted_path"
hash -r
for name in $(compgen -e); do
  case "$name" in
    GIT_*) unset "$name" ;;
  esac
done

readonly repo="AtefAndrus/ratatoskr"
readonly repo_url="https://github.com/$repo.git"

fail() {
  echo "release-publish: $*" >&2
  exit 1
}

version="${1:-}"
notes_file="${2:-}"
usage="usage: /bin/bash $repo_root/scripts/release-publish.sh <major.minor.patch> [notes-file]"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "$usage"
[ $# -le 2 ] || fail "$usage"
readonly tag="v$version"

if [ -n "$notes_file" ]; then
  [ -f "$notes_file" ] && [ -s "$notes_file" ] || fail "ノートのファイルが無いか空である: $notes_file"
  notes_file=$(realpath "$notes_file")
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# テンプレートを空にして、hook のひな形も含め何も持たない bare リポジトリにする
git init --quiet --bare --template= "$work"

g() {
  git --git-dir="$work" -c core.hooksPath=/dev/null "$@"
}

remote_ref() {
  local out
  out=$(g ls-remote "$repo_url" "$1") || fail "GitHub から $1 を読めない"
  # ls-remote のパターンは末尾一致なので、ref 名の完全一致で絞る
  printf '%s\n' "$out" | awk -F '\t' -v ref="$1" '$2 == ref { print $1 }'
}

# 作業中のリポジトリの main とタグを push 済みの内容に揃える。push の内容には影響しない後処理なので、失敗しても止めない。
sync_local() {
  local commit="$1" base="$2" local_tag local_main
  local lg=(git -C "$repo_root" --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false)
  g update-ref refs/release/commit "$commit"
  # mixed reset は作業ツリーに触れないので、準備したファイルや再実行までに加えた編集を失わない
  local recovery="main 上で git fetch --tags origin main && git reset refs/remotes/origin/main (作業ツリーは変わらず、stage だけが解除される)"
  if ! "${lg[@]}" fetch --quiet --no-tags "$work" refs/release/commit; then
    echo "release-publish: ローカルへの反映に失敗した。$recovery で揃える。" >&2
    return 0
  fi

  local_tag=$("${lg[@]}" rev-parse --quiet --verify "refs/tags/$tag" || true)
  if [ -z "$local_tag" ]; then
    # git tag は tag.gpgSign などの設定で注釈付きタグの作成に変わるので、ref を直接作る
    "${lg[@]}" update-ref "refs/tags/$tag" "$commit" "" || echo "release-publish: ローカルにタグ $tag を作れなかった。git fetch --tags で揃える。" >&2
  elif [ "$local_tag" != "$commit" ]; then
    echo "release-publish: ローカルのタグ $tag が $commit と違うコミットを指している。手で確認する。" >&2
  fi

  local_main=$("${lg[@]}" rev-parse --quiet --verify refs/heads/main || true)
  if [ "$local_main" != "$commit" ]; then
    if [ -n "$local_main" ] && [ "$local_main" != "$base" ] &&
      "${lg[@]}" merge-base --is-ancestor "$commit" "$local_main" 2>/dev/null; then
      return 0
    fi
    if [ "$("${lg[@]}" symbolic-ref --quiet HEAD || true)" != refs/heads/main ] ||
      ! "${lg[@]}" update-ref -m "release $tag" refs/heads/main "$commit" "$base"; then
      echo "release-publish: ローカルの main を $commit へ進められなかった。$recovery で揃える。" >&2
      return 0
    fi
  fi
  [ "$("${lg[@]}" symbolic-ref --quiet HEAD || true)" = refs/heads/main ] || return 0

  # main を進めても index は旧版のままなので揃える。ただし index が旧版の blob を指すファイルに限り、
  # 再実行までに stage された編集は残す。
  local file
  for file in package.json CHANGELOG.md; do
    # blob だけでなくモードと stage 番号も比べ、実行権限の変更や競合中のエントリを残す
    [ "$("${lg[@]}" ls-files --stage -- "$file")" = "100644 $(g rev-parse "$base:$file") 0	$file" ] || continue
    "${lg[@]}" reset --quiet -- "$file" ||
      echo "release-publish: $file の index を揃えられなかった。git reset -- $file で揃える (作業ツリーは変わらない)。" >&2
  done
}

# 公開済みの Release があれば URL を出して 0、無ければ 1、下書きなら 2 を返す。
# gh release view は下書きも返すが、デプロイは公開時にしか走らないので区別する。
published_release_url() {
  local state
  state=$(gh release view "$tag" -R "$repo" --json isDraft,url --jq '"\(.isDraft)\t\(.url)"' 2>/dev/null) || return 1
  [ "${state%%$'\t'*}" = false ] || return 2
  printf '%s\n' "${state#*$'\t'}"
}

readonly draft_message="GitHub Release $tag が下書きのまま存在する。内容を確認し、公開するか削除してから同じコマンドを再実行する"

create_release() {
  local url status=0
  # 作成は通ったが応答を受け取れなかった場合の再実行では、既にある Release をそのまま使う
  url=$(published_release_url) || status=$?
  case "$status" in
    0)
      echo "GitHub Release $tag は既に公開されている。"
      echo "$url"
      return 0
      ;;
    2) fail "$draft_message" ;;
  esac
  local args=(release create "$tag" -R "$repo" --title "$tag" --generate-notes --verify-tag)
  if [ -n "$notes_file" ]; then
    args+=(--notes-file "$notes_file")
  fi
  local created=0
  gh "${args[@]}" || created=$?
  status=0
  url=$(published_release_url) || status=$?
  case "$status" in
    0) [ "$created" = 0 ] || echo "gh は失敗を返したが GitHub Release $tag は公開されている。" ;;
    2) fail "$draft_message" ;;
    *)
      [ "$created" = 0 ] || fail "GitHub Release の作成に失敗した。原因を解消して同じコマンドを再実行する"
      fail "作成した GitHub Release $tag を読めない。gh release view $tag -R $repo で確認する"
      ;;
  esac
  echo "$url"
}

# タグが既に GitHub にあるなら push は終わっている。Release 作成だけが残った状態からの再実行として扱い、push はしない。
remote_tag=$(remote_ref "refs/tags/$tag")
if [ -n "$remote_tag" ]; then
  g fetch --quiet --no-tags "$repo_url" "refs/tags/$tag"
  g cat-file blob "$remote_tag:package.json" | grep -q -F -x "  \"version\": \"$version\"," ||
    fail "GitHub のタグ $tag は version $version のリリースコミットを指していない"
  echo "GitHub にタグ $tag があるので push を省き、GitHub Release の作成だけを行う。"
  sync_local "$remote_tag" "$(g rev-parse "$remote_tag^")"
  create_release
  exit 0
fi

base=$(remote_ref refs/heads/main)
[ -n "$base" ] || fail "GitHub に main が無い"
g fetch --quiet --no-tags "$repo_url" refs/heads/main

# 作業ツリーが古い main から作られていないかの確認。push の内容はこの値に依存しない。
local_head=$(git -C "$repo_root" --no-replace-objects rev-parse --verify HEAD) || fail "作業中のリポジトリの HEAD を読めない"
[ "$local_head" = "$base" ] || fail "作業中のリポジトリの HEAD ($local_head) が GitHub の main ($base) と一致しない"

pkg_blob=$(g hash-object -w --no-filters --stdin <"$repo_root/package.json")
changelog_blob=$(g hash-object -w --no-filters --stdin <"$repo_root/CHANGELOG.md")

g cat-file blob "$base:package.json" |
  sed "s/^  \"version\": \"[^\"]*\",\$/  \"version\": \"$version\",/" |
  cmp -s - <(g cat-file blob "$pkg_blob") ||
  fail "package.json の変更が version を $version にするだけではない"

first_heading=$(g cat-file blob "$changelog_blob" | grep -m1 '^## \[' || true)
[[ "$first_heading" == "## [$version] - "* ]] || fail "CHANGELOG.md の先頭見出しが $version でない: $first_heading"

export GIT_INDEX_FILE="$work/release-index"
g read-tree "$base"
g update-index --cacheinfo "100644,$pkg_blob,package.json"
g update-index --cacheinfo "100644,$changelog_blob,CHANGELOG.md"
tree=$(g write-tree)
unset GIT_INDEX_FILE

# 組み立てた tree が基準から 2 ファイルの内容変更だけであることを、モードを含めて確かめる
expected_diff=$(printf ':100644 100644 %s %s M\tCHANGELOG.md\n:100644 100644 %s %s M\tpackage.json' \
  "$(g rev-parse "$base:CHANGELOG.md")" "$changelog_blob" "$(g rev-parse "$base:package.json")" "$pkg_blob")
[ "$(g diff-tree -r --no-renames "$base" "$tree")" = "$expected_diff" ] ||
  fail "組み立てた tree が package.json と CHANGELOG.md の内容変更だけになっていない"

commit=$(g commit-tree "$tree" -p "$base" -m "[chore] bump version to $tag")
[ "$(g rev-list --parents -n 1 "$commit")" = "$commit $base" ] || fail "リリースコミットの親が $base だけでない"

# lease により、main が取得時の base から動いていたり (巻き戻しを含む)、タグが先に作られていたりすれば push 全体が拒否される
push_status=0
g push --atomic --no-follow-tags --no-verify \
  "--force-with-lease=refs/heads/main:$base" "--force-with-lease=refs/tags/$tag:" \
  "$repo_url" "$commit:refs/heads/main" "$commit:refs/tags/$tag" || push_status=$?

# push の終了コードは GitHub 側の状態を決めないので、読み直して判断する
remote_main=$(remote_ref refs/heads/main)
remote_tag=$(remote_ref "refs/tags/$tag")
if [ "$remote_main" != "$commit" ] || [ "$remote_tag" != "$commit" ]; then
  if [ "$remote_tag" = "" ] && [ "$remote_main" = "$base" ]; then
    fail "push が反映されなかった (終了コード $push_status)。作業中のリポジトリは変えていないので、原因を解消して同じコマンドを再実行できる"
  fi
  fail "push 後の GitHub が想定と違う (main=$remote_main, $tag=${remote_tag:-なし}, 期待=$commit)。手で確認する"
fi

sync_local "$commit" "$base"
create_release
