export function normalizeHandle(value: string): string {
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) {
    throw new Error(`不正な X アカウント名です: ${value}`);
  }
  return handle;
}

export function normalizeLabel(value: string): string {
  const label = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) {
    throw new Error(`不正な受信アカウントラベルです: ${value}`);
  }
  return label;
}
