// Contrôle du jeton du traitement autonome (même principe que notify-absence) : comparaison à temps constant.
export async function workerAuthorized(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (!provided || !expected || expected.length < 32) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
