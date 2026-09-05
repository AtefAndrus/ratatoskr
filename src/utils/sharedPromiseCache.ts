/**
 * 同じキーへの取得を 1 回に畳む、件数上限つきのキャッシュ。
 * 解決済みの値ではなく解決中の Promise を保持するため、同時に走った呼び出しも 1 回にまとまる。
 * 失敗は保持しない。取得できなかったキーは捨てて、次の呼び出しで引き直せるようにする。
 */
export class SharedPromiseCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("キャッシュの件数上限は 1 以上の整数である必要があります");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    const pending = load().catch((error: unknown) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, pending);
    // Map は挿入順を保つので、上限を超えた分は古いキーから外れる。
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
    return pending;
  }
}
