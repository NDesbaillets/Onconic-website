-- Formation : recueils de présentations (HTML ou PDF) classés par clinique puis pathologie, recherchables en texte intégral.
-- Lecture : membres ayant l'outil « formation » (médecins, CDC, assistantes, pharmaciens), recueils publiés seulement ; l'admin voit tout.
-- Dépôt, modification et suppression : admin. Les fichiers sont dans le bucket privé « formation », jamais dans le dépôt Git.
-- À exécuter après trials_roles.sql. Sans danger si relancé.

-- ===== Accès à l'outil « formation » =====
create or replace function public.tool_allowed(p_user uuid, p_tool text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; i text; m boolean; o boolean;
begin
  select role, institution, med_plus into r, i, m from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if r = 'admin' then return true; end if;
  if p_tool = 'medletters' then return r in ('clinician', 'cdc', 'pharmacist') and coalesce(m, false); end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'congres' then r in ('clinician', 'cdc', 'assistant', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'assistant', 'pharmacist')
    when 'formation' then r in ('clinician', 'cdc', 'assistant', 'pharmacist')
    when 'annuaire' then r in ('clinician', 'cdc', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'cdc', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'cdc', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'cdc', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician', 'cdc') and i = 'CHUV')
    else false end;
end;
$$;

create or replace function public.my_tools()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t), '{}') from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters', 'annuaire', 'contacts', 'formation']) t
  where public.tool_allowed(auth.uid(), t);
$$;

-- ===== Recueils =====
create table if not exists public.trainings (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 3 and 200),
  clinic text not null check (clinic in ('Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome',
                                         'Lower GI', 'Upper GI', 'ORL', 'Sarcomes', 'Radiologie interventionnelle')),
  pathology text not null check (char_length(pathology) between 2 and 120),
  tags text[] not null default '{}',
  level text not null default 'tous' check (level in ('residents', 'cadres', 'tous')),
  author text check (char_length(author) <= 200),
  summary text check (char_length(summary) <= 1000),
  kind text not null check (kind in ('html', 'pdf')),
  file_path text not null,
  file_size bigint,
  source_path text,                    -- fichier source modifiable (PowerPoint), facultatif
  slides jsonb not null default '[]',  -- [{ n, t (titre), x (texte normalisé) }] pour la recherche à la diapositive
  title_norm text not null default '', -- titre et pathologie normalisés (minuscules sans accents)
  search_norm text not null default '',-- titre, pathologie, mots-clés et texte, minuscules sans accents (calculé par l'application)
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trainings_clinic on public.trainings (clinic, pathology);

create or replace function public.trainings_stamp()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;
create or replace trigger trainings_stamp before update on public.trainings
  for each row execute function public.trainings_stamp();

alter table public.trainings enable row level security;
drop policy if exists "trainings: read" on public.trainings;
create policy "trainings: read" on public.trainings for select to authenticated
  using (public.current_role_name() = 'admin' or (status = 'published' and (select public.has_tool('formation'))));
drop policy if exists "trainings: admin write" on public.trainings;
create policy "trainings: admin write" on public.trainings for all to authenticated
  using (public.current_role_name() = 'admin') with check (public.current_role_name() = 'admin');
revoke all on public.trainings from anon;
grant select, insert, update, delete on public.trainings to authenticated;
revoke truncate, references, trigger on public.trainings from authenticated;

-- Recherche : tous les termes (déjà normalisés par l'application) doivent apparaître ; renvoie la première diapositive concernée
create or replace function public.trainings_search(p_terms text[])
returns table (id bigint, slide int, slide_title text, in_title boolean)
language sql stable set search_path = public as $$
  select t.id,
    (select (s ->> 'n')::int from jsonb_array_elements(t.slides) s
       where not exists (select 1 from unnest(p_terms) q where position(q in (s ->> 'x')) = 0) limit 1),
    (select s ->> 't' from jsonb_array_elements(t.slides) s
       where not exists (select 1 from unnest(p_terms) q where position(q in (s ->> 'x')) = 0) limit 1),
    not exists (select 1 from unnest(p_terms) q where position(q in t.title_norm) = 0)
  from public.trainings t
  where cardinality(p_terms) > 0
    and not exists (select 1 from unnest(p_terms) q where position(q in t.search_norm) = 0)
  order by 4 desc, t.title;
$$;
revoke execute on function public.trainings_search(text[]) from public, anon;
grant execute on function public.trainings_search(text[]) to authenticated;

-- ===== Fichiers : bucket privé =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('formation', 'formation', false, 52428800,
        array['text/html', 'application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "formation files: read" on storage.objects;
create policy "formation files: read" on storage.objects for select to authenticated
  using (bucket_id = 'formation' and (
    public.current_role_name() = 'admin'
    or ((select public.has_tool('formation')) and exists (
          select 1 from public.trainings t where t.status = 'published' and (t.file_path = name or t.source_path = name)))));
drop policy if exists "formation files: admin write" on storage.objects;
create policy "formation files: admin write" on storage.objects for all to authenticated
  using (bucket_id = 'formation' and public.current_role_name() = 'admin')
  with check (bucket_id = 'formation' and public.current_role_name() = 'admin');
