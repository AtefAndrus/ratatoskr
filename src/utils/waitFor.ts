/**
 * 上限つきで待ち、abort か外からの起床で切り上げる。
 * `register` が返した後始末は切り上げ時に必ず呼ぶ。呼ばないと起床の登録が待機のたびに積み上がる。
 * abort 済みの signal に addEventListener しても過去の abort は再通知されないため、
 * 待つ前に確認する。確認を落とすと、停止指示のあとタイマー満了まで受信ループが残る。
 */
export async function waitFor(
  timeoutMs: number,
  signal: AbortSignal,
  register: (wake: () => void) => (() => void) | void,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let listening = false;
    let unregister: (() => void) | void;
    const timer = setTimeout(finish, timeoutMs);
    const onAbort = (): void => finish();
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (listening) signal.removeEventListener("abort", onAbort);
      unregister?.();
      resolve();
    }
    unregister = register(finish);
    // register が同期的に起こしたときは、finish が unregister の代入前に走っている。
    // 後始末をここで補い、もう呼ばれない abort リスナも足さない。
    if (settled) {
      unregister?.();
      return;
    }
    listening = true;
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
