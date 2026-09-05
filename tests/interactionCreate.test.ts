import { describe, expect, test } from "bun:test";

import { watchAutocompleteChoices } from "../src/bot/events/interactionCreate";

describe("watch コマンドの autocomplete", () => {
  test("候補の表示名と処理値を分離する", () => {
    expect(watchAutocompleteChoices([{ handle: "usao926", displayName: "USAO@山奥" }])).toEqual([
      { name: "@usao926 (USAO@山奥)", value: "usao926" },
    ]);
  });
});
