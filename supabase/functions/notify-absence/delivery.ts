// Helpers purs : aucun texte libre dans les notifications externes ; déduplication seulement après succès.
import type { Abs } from "./message.ts";
export function externalAbsence<T extends Abs>(a: T): T {
  return { ...a, note: null, change_note: null };
}
export async function sendSharedOnce(sent: Set<string>, key: string, send: () => Promise<unknown>): Promise<void> {
  if (sent.has(key)) return;
  await send();
  sent.add(key);
}
export async function workerAuthorized(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (!provided || !expected || expected.length < 32) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
