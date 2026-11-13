// Base de test d'Oncoodle : PostgreSQL embarqué (PGlite) chargé avec les vrais scripts du dépôt et des données fictives.
// Partagé par oncoodle.test.mjs (SQL) et oncoodle-e2e.mjs (navigateur contre ce même SQL).
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
export const read = (p) => readFile(new URL(p, root), 'utf8');
export const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
// 1 admin, 2 direction, 3-4 médecins assistants Thoracique, 5 cadre Thoracique, 6 cadre Urologie, 7 infirmier, 8 assistante, 9 en attente, 10 CDC Thoracique, 11 médecin Urologie
export const PEOPLE = [[1, 'admin', []], [2, 'direction', []], [3, 'clinician', ['Thoracique']], [4, 'clinician', ['Thoracique']], [5, 'cadre', ['Thoracique']], [6, 'cadre', ['Urologie']],
  [7, 'nurse', []], [8, 'assistant', []], [9, 'member', []], [10, 'cdc', ['Thoracique']], [11, 'clinician', ['Urologie']]];

export async function makeDb() {
  const db = new PGlite();
  await db.exec(await read('tests/absences/fixture.sql'));
  for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql']) {
    try { await db.exec(await read('supabase/' + f)); } catch (e) { throw Error(`${f}: ${e.message} ${e.where || ''}`); }
  }
  await db.exec("create or replace function ch_today() returns date language sql stable as $$ select date '2026-11-11' $$;");
  for (const [n, role, clinics] of PEOPLE) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `test${n}@example.invalid`]);
    await db.query('insert into profiles(id,full_name,role,clinics,absence_validator) values($1,$2,$3,$4,$5)', [uid(n), `Test ${n}`, role === 'nurse' ? 'clinician' : role, clinics, role === 'cadre']);
  }
  await db.exec('grant select,update on profiles to authenticated;');
  for (const m of ['202611110001_absence_hardening', '202611120001_nurse_role', '202611120002_assistant_default_tools', '202611130001_securite_advisors']) {
    try { await db.exec(await read(`supabase/migrations/${m}.sql`)); } catch (e) { throw Error(`${m}: ${e.message} ${e.where || ''}`); }
  }
  await db.query("update profiles set role='nurse' where id=$1", [uid(7)]);
  const migration = await read('supabase/migrations/202611130002_oncoodle.sql');
  await db.exec(migration); await db.exec(migration); // réexécutable
  // Définition de supabase/schema.sql utilisée par les pages (has_tool)
  await db.exec("create or replace function public.has_tool(p_tool text) returns boolean language sql stable security definer set search_path = public as $$ select public.tool_allowed(auth.uid(), p_tool); $$; grant execute on function public.has_tool(text) to authenticated;");
  return db;
}
