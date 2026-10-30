-- Fiches tumeurs de la Ruche (contenu du dépôt privé onconic-content).
-- À exécuter une fois dans Supabase > SQL Editor, après schema.sql. Peut être relancé sans risque.
-- Écriture : uniquement par la clé secrète du dépôt onconic-content (GitHub Actions), qui contourne RLS.
-- Lecture : membres validés ; les brouillons ne sont visibles que des admins.

create table if not exists public.hive_pages (
  slug text primary key check (slug ~ '^[a-z0-9-]+$'),
  titre text not null,
  domaine text not null,
  domaine_libelle text not null,
  domaine_ordre int not null default 0,
  tumeur text,
  situation text,
  resume text,
  mots_cles text[] not null default '{}',
  recommandations text[] not null default '{}',
  derniere_revue date not null,
  date_limite_preuves date,
  statut text not null default 'brouillon' check (statut in ('brouillon', 'publie')),
  html text not null,
  sommaire jsonb not null default '[]',
  -- Textes sans accents, préparés par le build, pour la recherche plein texte
  recherche_entete text not null default '',
  recherche_corps text not null default '',
  fts tsvector generated always as (
    setweight(to_tsvector('french', recherche_entete), 'A') ||
    setweight(to_tsvector('french', recherche_corps), 'C')
  ) stored,
  publie_le timestamptz not null default now()
);

create index if not exists hive_pages_fts on public.hive_pages using gin (fts);

alter table public.hive_pages enable row level security;

drop policy if exists "hive pages: validated members read" on public.hive_pages;
create policy "hive pages: validated members read" on public.hive_pages
  for select to authenticated
  using (
    public.current_role_name() = 'admin'
    or (statut = 'publie' and public.current_role_name() in ('clinician', 'assistant'))
  );

revoke all on public.hive_pages from anon;
revoke insert, update, delete on public.hive_pages from authenticated;

-- Recherche classée par pertinence. security invoker : les règles RLS ci-dessus s'appliquent.
-- La requête doit arriver sans accents (fait par assets/js/fiches.js).
create or replace function public.hive_search(q text)
returns table (slug text, titre text, domaine_libelle text, situation text, resume text, derniere_revue date, statut text, rang real)
language sql stable security invoker set search_path = public as $$
  select p.slug, p.titre, p.domaine_libelle, p.situation, p.resume, p.derniere_revue, p.statut,
         ts_rank(p.fts, websearch_to_tsquery('french', q)) as rang
  from public.hive_pages p
  where p.fts @@ websearch_to_tsquery('french', q)
  order by rang desc
  limit 50;
$$;

revoke execute on function public.hive_search(text) from public, anon;
grant execute on function public.hive_search(text) to authenticated;
