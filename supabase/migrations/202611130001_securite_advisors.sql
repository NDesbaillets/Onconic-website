-- Sécurité : corrections issues de l'audit Supabase (advisors) du 13.11.2026.
-- Aucune donnée métier n'est modifiée. Transactionnel et réexécutable ; chaque objet n'est traité que s'il existe.
--
-- 1. absence_lo / absence_hi : search_path figé (avertissement « function_search_path_mutable »).
-- 2. Fonctions de déclencheur appelables via /rest/v1/rpc par anon et authenticated : droit d'exécution retiré.
--    Un déclencheur s'exécute sans ce droit ; seul l'appel direct devient impossible.
-- 3. GraphQL : extension pg_graphql supprimée. Le site n'utilise que l'API REST (supabase-js) ;
--    31 tables étaient listées dans le schéma GraphQL. Réactivable à tout moment (Database > Extensions).
-- 4. onconic_migrations : RLS activée. La table n'est accordée qu'à postgres et service_role, qui contournent la RLS.
-- 5. key_trials_bak_20261109 : copie temporaire du 09.11.2026 (75 fiches), supprimée.
--    Elle reste dans les sauvegardes Supabase (7 jours) et nocturnes (35 jours).
-- 6. TRUNCATE, REFERENCES et TRIGGER retirés à anon et authenticated sur toutes les tables du schéma public.
--    L'API REST n'utilise jamais ces droits ; TRUNCATE contourne la RLS. SELECT, INSERT, UPDATE, DELETE inchangés.
--
-- Non traité, volontairement :
-- - current_role_name() reste exécutable par anon : des règles RLS « to public » l'appellent (profiles, contact_requests).
--   Le retirer ferait échouer ces règles pour les visiteurs. Pour anon, la fonction renvoie NULL.
-- - Les 95 fonctions security definer appelables par authenticated : voulu, elles contrôlent elles-mêmes l'appelant.
-- - Les 19 tables avec RLS et sans règle : voulu, leur accès passe uniquement par ces fonctions.
-- - Protection des mots de passe compromis : réglage Auth, activé dans le tableau de bord.
begin;

-- 1. search_path figé (fonctions SQL sans accès aux tables : seules des fonctions de pg_catalog sont appelées)
do $$
begin
  if to_regprocedure('public.absence_lo(public.absences)') is not null then
    alter function public.absence_lo(public.absences) set search_path = '';
  end if;
  if to_regprocedure('public.absence_hi(public.absences)') is not null then
    alter function public.absence_hi(public.absences) set search_path = '';
  end if;
end $$;

-- 2. Fonctions de déclencheur non appelables directement
do $$
declare f text;
begin
  foreach f in array array['public.events_absence_flag_guard()', 'public.trial_flags_fill()'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;

-- 3. GraphQL
drop extension if exists pg_graphql;

-- 4. Table de suivi des migrations
do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    alter table public.onconic_migrations enable row level security;
  end if;
end $$;

-- 5. Copie temporaire de Key trials
drop table if exists public.key_trials_bak_20261109;

-- 6. Droits inutiles à l'API
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611130001') on conflict do nothing;
  end if;
end $$;

commit;
