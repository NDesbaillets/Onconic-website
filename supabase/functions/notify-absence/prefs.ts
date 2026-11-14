// Réglages de notifications d'un membre (profiles.notif_prefs). Fonction pure, testable hors Supabase.
// Format : { "<type>": { "email": false, "push": true }, ... }. Un type ou un canal absent est activé : sans réglage, tout est reçu.
// Un rappel n'est envoyé que si son type de base et le type « reminder » sont tous deux activés pour le canal.
export type Prefs = Record<string, { email?: boolean; push?: boolean } | undefined> | null | undefined;
export function wants(prefs: Prefs, kind: string, channel: "email" | "push", reminder = false): boolean {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const off = (k: string) => (p[k] && typeof p[k] === "object" ? (p[k] as { email?: boolean; push?: boolean })[channel] === false : false);
  if (off(kind)) return false;
  if (reminder && off("reminder")) return false;
  return true;
}
