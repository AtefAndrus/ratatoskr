import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/release-publish.sh", import.meta.url).pathname;

/** sync_local が作業中のリポジトリへの git に付けるオプションを、スクリプトから読み出す。 */
async function localGitOptions(): Promise<string[]> {
  const script = await Bun.file(SCRIPT).text();
  const match = /local lg=\(git -C "\$repo_root" ([^)]*)\)/.exec(script);
  if (!match?.[1]) throw new Error("sync_local の lg が見つからない");
  return match[1].split(" ");
}

function git(cwd: string, args: string[]): number {
  return Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  }).exitCode;
}

describe("release-publish.sh の sync_local", () => {
  test("origin を promisor remote にされても、欠けた追跡ブランチの祖先判定で remote のコマンドを実行しない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "release-publish-"));
    try {
      const repo = join(dir, "repo");
      const marker = join(dir, "marker");
      git(dir, ["init", "-q", repo]);
      git(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);
      // 遅延取得が起きると ext:: のコマンドがマーカーを作る
      git(repo, ["config", "core.repositoryformatversion", "1"]);
      git(repo, ["config", "extensions.partialClone", "origin"]);
      git(repo, ["config", "remote.origin.promisor", "true"]);
      git(repo, ["config", "remote.origin.url", `ext::sh -c touch% ${marker}`]);
      git(repo, ["config", "protocol.ext.allow", "always"]);
      const missing = "1".repeat(40);
      await Bun.write(join(repo, ".git/packed-refs"), `${missing} refs/remotes/origin/main\n`);
      const isAncestor = ["merge-base", "--is-ancestor", missing, "HEAD"];

      // オプションなしでは遅延取得でコマンドが実行されることを確かめ、この組み立てが攻撃を再現していると示す
      git(repo, isAncestor);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      git(repo, [...(await localGitOptions()), ...isAncestor]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
