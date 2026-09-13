---
name: release
description: Run the ratatoskr release process. Use when cutting a new version (e.g. `/release 0.7.0`) — bumps the version, generates a versioned CHANGELOG.md, commits, tags, pushes, and publishes a GitHub release with automatically generated notes, which triggers the Coolify deployment.
---

# Release Workflow

ratatoskr の v<version> をリリースする。
GitHub Release の公開を契機に `.github/workflows/deploy.yml` が Coolify へデプロイする。

コミット、push、Release 作成は `scripts/release-publish.sh` だけが行う。
`.claude/settings.local.json` の許可ルールは `/bin/bash <リポジトリの絶対パス>/scripts/release-publish.sh` の起動だけを許可しており、`git push` そのものは許可していない。
ルールに一致させるため、スクリプトは必ずこの形 (`/bin/bash` とリポジトリの絶対パス) で起動する。
スクリプトが失敗したときに、同じ操作を `git commit` や `git push` の直接実行で代替しない。失敗の内容をユーザーに報告して止まる。

## Step 1: Prepare

```bash
bun run release:prepare <version>
```

main が origin/main と一致しクリーンであることを確かめ、`bun run check` を通してから、`package.json` の version と CHANGELOG.md を更新する。
最後に、前回のタグから `src/db/schema.ts`、`src/config/`、`Dockerfile`、`docs/deployment.md` に入った差分の統計を出す。

`git diff` で、`package.json` は version の 1 行だけが変わり、CHANGELOG.md の先頭見出しが `## [<version>]` であることを確認する。

## Step 2: Decide the Operator Notes

GitHub の自動生成ノートは PR タイトルを並べるだけで、デプロイ時に必要な手順を含まない。
Step 1 が出した差分に次のいずれかがあるときだけ、自動生成ノートの前に付ける節を書く。

| 差分 | 書く節 |
| ---- | ---- |
| `SCHEMA_VERSION` の変更 | `## 移行`: 起動時に走るマイグレーションと、既存データや既存の経路の挙動がどうなるか |
| 環境変数の追加・変更・既定値の変更 | `## デプロイ後の確認` の冒頭: Coolify で設定が要るか、不要か |
| Dockerfile や永続ボリューム、Coolify 側の手作業 | `## 移行`: 必要な手作業 |
| 観測で確かめるべき挙動の変更 | `## デプロイ後の確認`: `/health`、`/watch list`、`bun run cli admin /admin/...` で何を見るか |

Renovate による Dockerfile の bun 更新のように、運用者の作業が要らない差分では節を書かない。
節の中身は対象 PR の本文を読んで書き、推測で埋めない。
ノートのファイルはリポジトリの外 (スクラッチ領域) に置く。リポジトリ内に置くと作業ツリーが汚れ、Step 3 が止まる。

## Step 3: Publish

```bash
# 節が無い場合
/bin/bash <リポジトリの絶対パス>/scripts/release-publish.sh <version>
# 節がある場合
/bin/bash <リポジトリの絶対パス>/scripts/release-publish.sh <version> <notes-file>
```

スクリプトは作業中のリポジトリで commit や push をしない。
作業ツリーからは `package.json` と CHANGELOG.md のバイト列だけを読み、GIT_* 環境変数を外した一時 bare リポジトリで次を行う。

1. `https://github.com/AtefAndrus/ratatoskr.git` の main を取得し、作業中のリポジトリの HEAD と一致することを確かめる
2. `package.json` が main の内容から version を `<version>` にしただけであること、CHANGELOG.md の先頭見出しが `<version>` であることを確かめる
3. 2 ファイルから blob、tree、commit を組み立て、tree が main から 2 ファイルの内容変更だけであることを検証する
4. その commit を main とタグ `v<version>` として `--atomic --no-follow-tags --no-verify` で push する。main が取得時から動いていたり、タグが既にあったりすれば lease で拒否される
5. push の終了コードではなく GitHub の ref を読み直して成否を決め、成功したら作業中のリポジトリの main とタグを揃え、`gh release create --generate-notes --verify-tag` を実行する

main の ruleset は必須ステータスチェックを課すが Admin ロールはバイパスでき、push は通る。
検査は Step 1 の `bun run check` で済んでおり、リリースコミットで変わるのは版の文字列と CHANGELOG だけである。

失敗したときは次のとおりに扱う。

- push が反映されなかったと表示された場合、作業中のリポジトリは変わっていない。表示された原因を解消し、同じコマンドを再実行する。
- push は済んだが Release の作成に失敗した場合、同じコマンドを再実行する。GitHub に `v<version>` のタグがあり、そのコミットの `package.json` が `<version>` なら、push を省いて Release の作成だけを行う。
- push 後の GitHub が想定と違うと表示された場合は、再実行せずにユーザーに報告する。
- ローカルへの反映や index の同期に失敗したという警告だけが出た場合、リリースは完了している。警告に表示されたコマンドで揃える。どれも作業ツリーを変えないので、再実行までに加えた編集は残る。
- push は済んだが GitHub Release の作成で gh が失敗を返した場合も、同じコマンドを再実行する。Release が既に公開されていれば、作り直さずにその URL を表示する。同じタグの下書きがある場合は、デプロイが走らないまま完了扱いにしないよう停止するので、下書きをユーザーに見せて公開か削除かを決めてもらう。

## Step 4: Verify

1. スクリプトが最後に出力した Release の URL を開ける: `gh release view v<version>`
2. Deploy workflow が成功している: `gh run list --workflow deploy.yml -L 1`
3. Release の URL をユーザーに報告する
