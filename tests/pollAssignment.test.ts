import { describe, expect, test } from "bun:test";

import { assignTargets, POLL_REDUNDANCY } from "../src/services/pollAssignment";

const targets = Array.from({ length: 40 }, (_, index) => ({ id: index + 1 }));

function assignedReceivers(targetId: number, receiverIds: readonly number[]): number[] {
  return receiverIds.filter((receiverId) =>
    assignTargets(targets, receiverId, receiverIds).some((target) => target.id === targetId),
  );
}

describe("監視対象の受信アカウントへの振り分け", () => {
  test("受信が 1 台ならその 1 台が全対象を持つ", () => {
    expect(assignTargets(targets, 7, [7])).toHaveLength(targets.length);
  });

  test("受信が 2 台なら全員が全対象を持つ", () => {
    expect(assignTargets(targets, 3, [3, 8])).toHaveLength(targets.length);
    expect(assignTargets(targets, 8, [3, 8])).toHaveLength(targets.length);
  });

  test("受信が 3 台以上でも、どの対象も必ず 2 台が担当する", () => {
    const receiverIds = [2, 5, 9, 11, 14];
    for (const target of targets) {
      expect(assignedReceivers(target.id, receiverIds)).toHaveLength(POLL_REDUNDANCY);
    }
  });

  test("担当は受信アカウントへ大きく偏らない", () => {
    const receiverIds = [1, 2, 3, 4];
    const loads = receiverIds.map((id) => assignTargets(targets, id, receiverIds).length);
    // 40 対象 × 冗長度 2 を 4 台で割ると平均 20 件。ハッシュのばらつきぶんの幅を見る。
    for (const load of loads) {
      expect(load).toBeGreaterThan(10);
      expect(load).toBeLessThan(30);
    }
    expect(loads.reduce((sum, load) => sum + load, 0)).toBe(targets.length * POLL_REDUNDANCY);
  });

  test("受信が 1 台増えても、担当が動くのは一部の対象だけ", () => {
    const before = [1, 2, 3];
    const after = [1, 2, 3, 4];
    const moved = targets.filter(
      (target) =>
        assignedReceivers(target.id, before).join() !== assignedReceivers(target.id, after).join(),
    );
    // 剰余で振ると全対象が動く。rendezvous なら増えた 1 台が奪う分だけに収まる。
    expect(moved.length).toBeLessThan(targets.length / 2);
  });

  test("受信が 1 台減っても、残った 2 台が持っていた対象は動かない", () => {
    const before = [1, 2, 3, 4];
    const after = [1, 2, 3];
    for (const target of targets) {
      const kept = assignedReceivers(target.id, before).filter((id) => id !== 4);
      expect(assignedReceivers(target.id, after)).toEqual(expect.arrayContaining(kept));
    }
  });

  test("並び順が違っても結果は同じ", () => {
    expect(assignTargets(targets, 2, [1, 2, 3]).map((target) => target.id)).toEqual(
      assignTargets(targets, 2, [3, 1, 2]).map((target) => target.id),
    );
  });

  test("担当がゼロになる受信には対象を 1 件だけ持たせる", () => {
    // 対象 1 件を受信 3 台で分けると 1 台が余る。その 1 台も取得を続けないと認証切れを検知できない。
    const single = [{ id: 1 }];
    const receiverIds = [1, 2, 3];
    for (const receiverId of receiverIds) {
      expect(assignTargets(single, receiverId, receiverIds)).toHaveLength(1);
    }
  });

  test("受信が対象より多くても、取得の総数は受信台数倍にならない", () => {
    const few = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const receiverIds = Array.from({ length: 10 }, (_, index) => index + 1);
    const total = receiverIds.reduce(
      (sum, receiverId) => sum + assignTargets(few, receiverId, receiverIds).length,
      0,
    );
    // HRW の割り当て 3 x 2 = 6 件に、担当ゼロの受信のヘルスチェック 1 件ずつが乗るだけ
    expect(total).toBeLessThanOrEqual(few.length * POLL_REDUNDANCY + receiverIds.length);
    // 全対象へフォールバックすると 3 x 10 = 30 件になる
    expect(total).toBeLessThan(few.length * receiverIds.length);
  });

  test("担当ゼロの受信が選ぶ 1 件は受信ごとに決まっていて変わらない", () => {
    const few = [{ id: 10 }, { id: 20 }, { id: 30 }];
    const receiverIds = Array.from({ length: 8 }, (_, index) => index + 1);
    for (const receiverId of receiverIds) {
      const first = assignTargets(few, receiverId, receiverIds);
      expect(assignTargets(few, receiverId, receiverIds)).toEqual(first);
    }
  });

  test("一覧が空、または自分が載っていないときは全対象を持つ", () => {
    expect(assignTargets(targets, 5, [])).toHaveLength(targets.length);
    expect(assignTargets(targets, 99, [1, 2, 3])).toHaveLength(targets.length);
  });

  test("対象が無ければ空を返す", () => {
    expect(assignTargets([], 1, [1, 2, 3])).toEqual([]);
  });
});
