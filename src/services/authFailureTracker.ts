import { XPushRegistrationError } from "../x/pushRegistration";

export type AuthOutcome = "ok" | "failed" | "unknown";

/** X が資格情報を拒むときのステータス。 */
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

/**
 * 取得の応答を認証の成否へ寄せる。
 * 429 や 5xx を成功に数えると、認証が切れている最中に連続失敗が途切れ、
 * 伝えた状態が実態とずれる。資格情報の可否が読めない応答は判断材料にしない。
 */
export function authOutcomeOfResponse(responseStatus: number | null): AuthOutcome {
  if (responseStatus === null) return "unknown";
  if (AUTH_FAILURE_STATUSES.has(responseStatus)) return "failed";
  return responseStatus >= 200 && responseStatus < 300 ? "ok" : "unknown";
}

/**
 * provisioning の失敗を認証の成否へ寄せる。
 * 鍵生成、Mozilla AutoPush 登録、DB 更新も同じ経路で失敗するため、X が資格情報を拒んだ場合だけを
 * 認証失敗に数える。そうしないと AutoPush 側の障害で「Cookie が切れている」と誤通知する。
 */
export function authOutcomeOfProvisioningError(error: unknown): AuthOutcome {
  if (!(error instanceof XPushRegistrationError)) return "unknown";
  return authOutcomeOfResponse(error.result.status);
}

export type AuthHealth = "healthy" | "failing";
export type AuthAlert = "failing" | "recovered";

export interface AuthTrackerOptions {
  threshold: number;
  /** 通知の送信が落ちたあと、次に送るまで空ける時間。 */
  retryDelayMs: number;
  now?: () => number;
}

/**
 * 受信アカウントの認証状態を持ち、運用者へ知らせるべき変化を返す。
 * X は資格情報を拒んでもプロセスを止めず配信だけが静かに落ちるため、状態変化を外へ出す役をここに置く。
 *
 * 「通知したかどうか」というイベントの履歴ではなく「最後に伝わっている状態」を持つ。
 * 送るべき通知は現在の状態との差分から毎回導くので、送信の遅れや失敗で食い違っても次の判定で
 * その時点の正しい差分に収束する。イベントを取りこぼして抑止が固まることがない。
 *
 * 判定できなかった取得 (ネットワーク障害など) は連続失敗を進めも切りもしない。
 * 失敗として数えると瞬断で誤通知になり、成功として数えると連続失敗が途切れて認証切れを取り逃がす。
 */
export class AuthFailureTracker {
  private streak = 0;
  /** 運用者へ最後に伝わっている状態。送信できたときだけ動く。 */
  private notified: AuthHealth = "healthy";
  private sending = false;
  private retryAtMs = 0;

  constructor(private readonly options: AuthTrackerOptions) {
    if (!Number.isInteger(options.threshold) || options.threshold < 1) {
      throw new Error("認証失敗の通知閾値は 1 以上の整数である必要があります");
    }
    if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) {
      throw new Error("通知の再送間隔は 0 以上の有限値である必要があります");
    }
  }

  get failureStreak(): number {
    return this.streak;
  }

  get health(): AuthHealth {
    return this.streak >= this.options.threshold ? "failing" : "healthy";
  }

  /** 送信中なら true。receiver を作り直しても送信が二重にならないよう外から見える。 */
  get busy(): boolean {
    return this.sending;
  }

  record(outcome: AuthOutcome): void {
    if (outcome === "unknown") return;
    this.streak = outcome === "ok" ? 0 : this.streak + 1;
  }

  /** 送るべき通知。現在の状態と最後に伝わっている状態が同じなら無い。 */
  pending(): AuthAlert | null {
    if (this.health === this.notified) return null;
    return this.health === "failing" ? "failing" : "recovered";
  }

  /** 送信を始めてよければその通知を返す。送信中と、送信が落ちた直後の待ち時間は返さない。 */
  beginSend(): AuthAlert | null {
    if (this.sending) return null;
    const alert = this.pending();
    if (alert === null || this.now() < this.retryAtMs) return null;
    this.sending = true;
    return alert;
  }

  /**
   * 送信の結果を反映する。
   * 反映するのは送信を始めた時点の状態で、その間に状態が変わっていれば次の `pending` が拾う。
   */
  endSend(sent: AuthAlert, delivered: boolean): void {
    this.sending = false;
    if (!delivered) {
      // 通知先が落ちている間、取得のたびに送信を試すと要求とログが積み上がる。
      this.retryAtMs = this.now() + this.options.retryDelayMs;
      return;
    }
    this.notified = sent === "failing" ? "failing" : "healthy";
    this.retryAtMs = 0;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
