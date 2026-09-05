/**
 * 1 つの監視対象を内部 GraphQL で追う受信アカウントの台数。
 * 1 台が認証切れやネットワーク障害で止まっても対象が無人にならないよう 2 台に重ねる。
 */
export const POLL_REDUNDANCY = 2;

/**
 * 監視対象を受信アカウントへ振り分ける。
 *
 * 剰余ではなく rendezvous hashing で選ぶ。剰余だと受信が 1 台増減しただけでほぼ全対象の担当が
 * 入れ替わり、担当を降りた側と受け取った側の周回がすれ違う間だけ取得が空く。
 * rendezvous なら動くのは増減した受信が関わる対象だけで済む。
 *
 * 担当がゼロになる受信には対象を 1 件だけ持たせる。
 * 内部 GraphQL の取得はその受信の認証情報が生きているかを確かめる唯一の経路なので、
 * 取得を 1 度も行わない受信ができると認証切れを検知できなくなる。
 * 全対象を持たせると、受信が対象より多い構成で取得が受信台数倍に戻ってしまう。
 */
export function assignTargets<T extends { id: number }>(
  targets: readonly T[],
  receiverId: number,
  /** 有効な受信アカウントの ID。順序は問わない。 */
  receiverIds: readonly number[],
): T[] {
  if (receiverIds.length === 0 || !receiverIds.includes(receiverId)) return [...targets];
  const assigned = targets.filter((target) =>
    topReceivers(target.id, receiverIds).includes(receiverId),
  );
  if (assigned.length > 0 || targets.length === 0) return assigned;
  return [targets[mix(receiverId) % targets.length]!];
}

function topReceivers(targetId: number, receiverIds: readonly number[]): number[] {
  return (
    receiverIds
      .map((receiverId) => ({ receiverId, score: score(targetId, receiverId) }))
      // 得点が並んだときは ID の小さい側を選び、一覧の並び順に結果が左右されないようにする。
      .toSorted((left, right) => right.score - left.score || left.receiverId - right.receiverId)
      .slice(0, Math.min(POLL_REDUNDANCY, receiverIds.length))
      .map((entry) => entry.receiverId)
  );
}

function score(targetId: number, receiverId: number): number {
  return mix(mix(targetId) ^ mix(Math.imul(receiverId, 0x9e37_79b1)));
}

/** murmur3 の最終混合。散らばればよいので暗号強度は要らない。 */
function mix(value: number): number {
  let mixed = value | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0_aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a_2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}
