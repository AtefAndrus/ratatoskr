import { describe, expect, test } from "bun:test";

import {
  AuthFailureTracker,
  authOutcomeOfProvisioningError,
  authOutcomeOfResponse,
} from "../src/services/authFailureTracker";
import { XPushRegistrationError } from "../src/x/pushRegistration";

function pushRegistrationError(status: number): XPushRegistrationError {
  return new XPushRegistrationError({
    requestedAt: "2026-09-05T00:00:00.000Z",
    status,
    responseText: "",
  });
}

let clock = 0;

function createTracker(threshold = 3, retryDelayMs = 0): AuthFailureTracker {
  clock = 0;
  return new AuthFailureTracker({ threshold, retryDelayMs, now: () => clock });
}

/** 通知が毎回送れた運用。 */
function settle(tracker: AuthFailureTracker, delivered = true): void {
  const alert = tracker.beginSend();
  if (alert !== null) tracker.endSend(alert, delivered);
}

describe("応答から認証の成否を読む", () => {
  test("2xx だけを成功とする", () => {
    expect(authOutcomeOfResponse(200)).toBe("ok");
    expect(authOutcomeOfResponse(204)).toBe("ok");
  });

  test("X が資格情報を拒むステータスだけを失敗とする", () => {
    expect(authOutcomeOfResponse(401)).toBe("failed");
    expect(authOutcomeOfResponse(403)).toBe("failed");
  });

  test("資格情報の可否が読めない応答は判断材料にしない", () => {
    // 429 や 5xx を成功に寄せると、認証が切れている最中に連続失敗が途切れて通知が出なくなる
    expect(authOutcomeOfResponse(429)).toBe("unknown");
    expect(authOutcomeOfResponse(500)).toBe("unknown");
    expect(authOutcomeOfResponse(503)).toBe("unknown");
    expect(authOutcomeOfResponse(404)).toBe("unknown");
    expect(authOutcomeOfResponse(null)).toBe("unknown");
  });
});

describe("provisioning の失敗から認証の成否を読む", () => {
  test("X の Web Push 登録が資格情報を拒んだときだけ失敗とする", () => {
    expect(authOutcomeOfProvisioningError(pushRegistrationError(401))).toBe("failed");
    expect(authOutcomeOfProvisioningError(pushRegistrationError(403))).toBe("failed");
  });

  test("X 以外の失敗は判断材料にしない", () => {
    // 鍵生成、Mozilla AutoPush 登録、DB 更新も同じ経路で失敗する
    expect(authOutcomeOfProvisioningError(new Error("AutoPush unreachable"))).toBe("unknown");
    expect(authOutcomeOfProvisioningError(pushRegistrationError(500))).toBe("unknown");
    expect(authOutcomeOfProvisioningError(undefined)).toBe("unknown");
  });
});

describe("受信アカウントの認証切れ判定", () => {
  test("閾値に達するまでは通知しない", () => {
    const tracker = createTracker(3);
    for (let i = 0; i < 2; i += 1) {
      tracker.record("failed");
      expect(tracker.pending()).toBeNull();
    }
    tracker.record("failed");
    expect(tracker.pending()).toBe("failing");
  });

  test("送れた通知は繰り返さない", () => {
    const tracker = createTracker(2);
    tracker.record("failed");
    tracker.record("failed");
    settle(tracker);
    tracker.record("failed");
    expect(tracker.pending()).toBeNull();
  });

  test("送れなかった通知は待ち時間のあとにもう一度送れる", () => {
    const tracker = createTracker(2, 1000);
    tracker.record("failed");
    tracker.record("failed");
    settle(tracker, false);

    // 通知先が落ちている間、取得のたびに送信を試さない
    tracker.record("failed");
    expect(tracker.pending()).toBe("failing");
    expect(tracker.beginSend()).toBeNull();

    clock += 1000;
    expect(tracker.beginSend()).toBe("failing");
  });

  test("送信中に立った判定は捨てる", () => {
    const tracker = createTracker(1);
    expect(tracker.busy).toBe(false);
    tracker.record("failed");
    const first = tracker.beginSend();
    expect(first).toBe("failing");
    expect(tracker.busy).toBe(true);
    tracker.record("failed");
    expect(tracker.beginSend()).toBeNull();
    tracker.endSend(first!, true);
    expect(tracker.busy).toBe(false);
  });

  test("成功で連続失敗が切れ、伝えた状態が失敗なら回復を知らせる", () => {
    const tracker = createTracker(2);
    tracker.record("failed");
    tracker.record("failed");
    settle(tracker);
    tracker.record("ok");
    expect(tracker.failureStreak).toBe(0);
    expect(tracker.pending()).toBe("recovered");
    settle(tracker);
    expect(tracker.pending()).toBeNull();
  });

  test("回復通知が送れないまま再び失敗しても、伝わっている状態と一致すれば何も送らない", () => {
    const tracker = createTracker(2, 0);
    tracker.record("failed");
    tracker.record("failed");
    settle(tracker);

    tracker.record("ok");
    const recovering = tracker.beginSend();
    expect(recovering).toBe("recovered");
    // 回復通知の送信中に再び認証が切れる
    tracker.record("failed");
    tracker.record("failed");
    tracker.endSend(recovering!, false);

    // 運用者には「切れている」と伝わったままで、現在も切れている。送るものは無い
    expect(tracker.health).toBe("failing");
    expect(tracker.pending()).toBeNull();

    // 回復すれば、伝わっている状態との差分が生まれて通知が立つ
    tracker.record("ok");
    expect(tracker.pending()).toBe("recovered");
  });

  test("通知前に回復したときは何も知らせない", () => {
    const tracker = createTracker(3);
    tracker.record("failed");
    settle(tracker);
    tracker.record("ok");
    expect(tracker.pending()).toBeNull();
    expect(tracker.failureStreak).toBe(0);
  });

  test("判定できない取得は連続失敗を進めも切りもしない", () => {
    const tracker = createTracker(3);
    tracker.record("failed");
    tracker.record("failed");
    tracker.record("unknown");
    expect(tracker.failureStreak).toBe(2);
    expect(tracker.pending()).toBeNull();
    // 瞬断を挟んでも 3 回目の失敗で通知が立つ
    tracker.record("failed");
    expect(tracker.pending()).toBe("failing");
  });

  test("組み立ての値を検証する", () => {
    expect(() => createTracker(0)).toThrow();
    expect(() => createTracker(3, -1)).toThrow();
  });
});
