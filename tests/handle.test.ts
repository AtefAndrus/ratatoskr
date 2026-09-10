import { describe, expect, test } from "bun:test";

import { normalizeHandle, parseHandleInput } from "../src/db/handle";

describe("normalizeHandle", () => {
  test("@ と大文字を落とす", () => {
    expect(normalizeHandle("@Kashiyuki_Yuki")).toBe("kashiyuki_yuki");
  });

  test("URL は受け付けない", () => {
    expect(() => normalizeHandle("https://x.com/kashiyuki_yuki")).toThrow();
  });
});

describe("parseHandleInput", () => {
  test("アカウント名はそのまま通す", () => {
    expect(parseHandleInput("  @Kashiyuki_Yuki ")).toBe("kashiyuki_yuki");
  });

  test("プロフィール URL からアカウント名を取り出す", () => {
    expect(parseHandleInput("https://x.com/kashiyuki_yuki")).toBe("kashiyuki_yuki");
  });

  test("タブとクエリが付いた URL からも取り出す", () => {
    expect(parseHandleInput("https://x.com/kashiyuki_yuki/media?filter=photo")).toBe(
      "kashiyuki_yuki",
    );
  });

  test("個別投稿の URL からも取り出す", () => {
    expect(parseHandleInput("https://x.com/Kashiyuki_Yuki/status/2095819158227210259")).toBe(
      "kashiyuki_yuki",
    );
  });

  test("スキームと www の有無を問わない", () => {
    expect(parseHandleInput("x.com/kashiyuki_yuki")).toBe("kashiyuki_yuki");
    expect(parseHandleInput("http://www.twitter.com/kashiyuki_yuki/")).toBe("kashiyuki_yuki");
  });

  test("Bot が書き換えたドメインのリンクを貼り戻せる", () => {
    expect(parseHandleInput("https://fixupx.com/kashiyuki_yuki/status/1")).toBe("kashiyuki_yuki");
    expect(parseHandleInput("https://fixvx.com/kashiyuki_yuki")).toBe("kashiyuki_yuki");
  });

  test("アカウント名にならないパスは弾く", () => {
    for (const url of [
      "https://x.com/i/web/status/2095819158227210259",
      "https://x.com/home",
      "https://x.com/login",
      "https://x.com/signup",
      "https://x.com/messages/1-2",
    ]) {
      expect(() => parseHandleInput(url)).toThrow("URL からアカウント名を特定できません");
    }
  });

  test("パーセントエンコードされたアカウント名も読む", () => {
    expect(parseHandleInput("https://x.com/%6Bashiyuki_yuki")).toBe("kashiyuki_yuki");
    expect(parseHandleInput("https://x.com/kashiyuki%5Fyuki")).toBe("kashiyuki_yuki");
    expect(() => parseHandleInput("https://x.com/%69/web/status/1")).toThrow(
      "URL からアカウント名を特定できません",
    );
    expect(() => parseHandleInput("https://x.com/a%2Fb")).toThrow("不正な X アカウント名です");
    // 壊れたエンコードはデコードせずに文字種検査へ渡す。
    expect(() => parseHandleInput("https://x.com/a%ZZ")).toThrow("不正な X アカウント名です");
  });

  test("アカウント名が無い URL は弾く", () => {
    expect(() => parseHandleInput("https://x.com/")).toThrow(
      "URL にアカウント名が含まれていません",
    );
  });

  test("X 以外のホストはアカウント名として扱い、結果として弾かれる", () => {
    // ホストを名前の一部に含めるだけの URL や、www 以外のサブドメインは通さない。
    for (const url of [
      "https://example.com/kashiyuki_yuki",
      "https://notx.com/kashiyuki_yuki",
      "https://x.com.evil.example/kashiyuki_yuki",
      "https://mobile.x.com/kashiyuki_yuki",
      "https://x.com@evil.example/kashiyuki_yuki",
    ]) {
      expect(() => parseHandleInput(url)).toThrow("不正な X アカウント名です");
    }
  });

  test("大文字のホストと末尾のスラッシュを受け付ける", () => {
    expect(parseHandleInput("HTTPS://WWW.X.COM/Kashiyuki_Yuki/")).toBe("kashiyuki_yuki");
  });

  test("16 文字以上のパス要素は弾く", () => {
    expect(() => parseHandleInput("https://x.com/abcdefghijklmnop")).toThrow(
      "不正な X アカウント名です",
    );
  });
});
