---
name: release
description: Run the ratatoskr release process. Use when cutting a new version (e.g. `/release 0.7.0`) — bumps the version, generates a versioned CHANGELOG.md, commits, tags, pushes, and publishes a GitHub release with automatically generated notes, which triggers the Coolify deployment.
---

# Release Workflow

ratatoskr の v<version> をリリースする。
GitHub Release の公開を契機に `.github/workflows/deploy.yml` が Coolify へデプロイする。

コミット、push、Release 作成は `scripts/release-publish.sh` だけが行う。
`.claude/settings.json` はこのスクリプトの起動だけを許可しており、`git push` そのものは許可していない。
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
bun run release:publish <version>
# 節がある場合
bun run release:publish <version> <notes-file>
```

スクリプトは次を検証してから、`LEFTHOOK=0` で main にリリースコミットを作り、タグを付け、main とタグを `--atomic` で push し、`gh release create --generate-notes --verify-tag` を実行する。

- main 上にいて、HEAD が origin/main と一致する
- 変更が `package.json` と CHANGELOG.md だけで、`package.json` は version を `<version>` にする変更だけである
- CHANGELOG.md の先頭見出しが `<version>` である
- タグ `v<version>` がローカルにも origin にも無い

main の ruleset は必須ステータスチェックを課すが Admin ロールはバイパスでき、push は通る。
検査は Step 1 の `bun run check` で済んでおり、リリースコミットで変わるのは版の文字列だけである。

## Step 4: Verify

1. スクリプトが最後に出力した Release の URL を開ける: `gh release view v<version>`
2. Deploy workflow が成功している: `gh run list --workflow deploy.yml -L 1`
3. Release の URL をユーザーに報告する
