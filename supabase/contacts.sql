-- Annuaire des médecins (contacts internes CHUV et externes) : personnes et services, numéros complets, recherche libre.
-- Visible des médecins, assistantes, pharmaciens (adresse CHUV, institution = 'CHUV') et des admins (outil « contacts »). Tout utilisateur de l'outil peut ajouter et modifier une fiche ;
-- la suppression est réservée à l'auteur de la fiche et aux admins.
-- Les numéros sont stockés en entier (+412131xxxxx pour un raccourci CHUV commençant par 4, +417955xxxxx pour un 6) ;
-- le site affiche le raccourci à 5 chiffres. Les données elles-mêmes ne sont jamais versionnées dans le dépôt (public).
-- À exécuter après annuaire.sql, avant de déployer le site qui l'utilise. Sans danger si relancé.

-- ===== Accès à l'outil « contacts » : médecins et pharmaciens (admin : toujours) =====
create or replace function public.tool_allowed(p_user uuid, p_tool text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; i text; m boolean; o boolean;
begin
  select role, institution, med_plus into r, i, m from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if r = 'admin' then return true; end if;
  -- Lettres médicales : accès « médecin plus », attribué un par un
  if p_tool = 'medletters' then return r in ('clinician', 'pharmacist') and coalesce(m, false); end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'congres' then r in ('clinician', 'assistant', 'pharmacist')
    when 'trials' then r in ('clinician', 'assistant', 'pharmacist')
    when 'annuaire' then r in ('clinician', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician') and i = 'CHUV')
    else false end;
end;
$$;

create or replace function public.my_tools()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t), '{}') from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters', 'annuaire', 'contacts']) t
  where public.tool_allowed(auth.uid(), t);
$$;

-- ===== Contacts =====
create table if not exists public.contacts (
  id bigint generated always as identity primary key,
  last_name text check (char_length(last_name) <= 100),
  first_name text check (char_length(first_name) <= 100),
  service text not null check (char_length(service) between 2 and 200),
  detail text check (char_length(detail) <= 200),      -- fonction ou précision de la personne ou du service (cadre, ICUS, secrétaire…)
  label text check (char_length(label) <= 100),        -- étiquette du numéro : jour, nuit/WE, fixe, mobile, plage horaire…
  scope text not null check (scope in ('interne', 'externe')),
  phone text check (char_length(phone) <= 40 and phone ~ '^\+?[\d\s().\/-]{3,40}$'),   -- numéro complet
  email text check (char_length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  notes text check (char_length(notes) <= 1000),       -- jamais de données de patients
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index if not exists contacts_unique on public.contacts
  (lower(coalesce(last_name, '')), lower(coalesce(first_name, '')), lower(service), lower(coalesce(detail, '')), coalesce(phone, ''));
alter table public.contacts add column if not exists label text check (char_length(label) <= 100);
create index if not exists contacts_service on public.contacts (lower(service));

create or replace function public.contacts_stamp()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end;
$$;
create or replace trigger contacts_stamp before update on public.contacts
  for each row execute function public.contacts_stamp();

alter table public.contacts enable row level security;
do $$ begin
  create policy "contacts: read" on public.contacts for select to authenticated using ((select public.has_tool('contacts')));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "contacts: insert" on public.contacts for insert to authenticated
    with check ((select public.has_tool('contacts')) and created_by = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "contacts: update" on public.contacts for update to authenticated
    using ((select public.has_tool('contacts'))) with check ((select public.has_tool('contacts')));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "contacts: delete" on public.contacts for delete to authenticated
    using ((select public.current_role_name()) = 'admin' or ((select public.has_tool('contacts')) and created_by = auth.uid()));
exception when duplicate_object then null; end $$;
revoke all on public.contacts from anon;
grant select, insert, update, delete on public.contacts to authenticated;
revoke truncate, references, trigger on public.contacts from authenticated;

-- ===== Import Excel (admin ou pharmacien) : ajoute les nouvelles fiches et met à jour celles de même nom, service, précision et numéro ; ne supprime rien =====
create or replace function public.contacts_import(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_new int := 0; n_upd int := 0; r record; was_new boolean;
begin
  if not public.is_app_admin('contacts') then
    raise exception 'admin only' using errcode = '42501';
  end if;
  for r in
    select nullif(trim(x.first_name), '') as first_name, nullif(trim(x.last_name), '') as last_name, nullif(trim(x.service), '') as service,
      nullif(trim(x.detail), '') as detail, nullif(trim(x.label), '') as label, lower(trim(x.scope)) as scope, nullif(trim(x.phone), '') as phone,
      nullif(trim(x.email), '') as email, nullif(trim(x.notes), '') as notes
    from jsonb_to_recordset(p_rows) as x(first_name text, last_name text, service text, detail text, label text, scope text, phone text, email text, notes text)
  loop
    insert into public.contacts (first_name, last_name, service, detail, label, scope, phone, email, notes)
    values (r.first_name, r.last_name, r.service, r.detail, r.label, r.scope, r.phone, r.email, r.notes)
    on conflict (lower(coalesce(last_name, '')), lower(coalesce(first_name, '')), lower(service), lower(coalesce(detail, '')), coalesce(phone, '')) do update set
      scope = excluded.scope, label = coalesce(excluded.label, public.contacts.label), email = coalesce(excluded.email, public.contacts.email), notes = coalesce(excluded.notes, public.contacts.notes)
    returning (xmax = 0) into was_new;
    if was_new then n_new := n_new + 1; else n_upd := n_upd + 1; end if;
  end loop;
  return jsonb_build_object('inserted', n_new, 'updated', n_upd);
end;
$$;
revoke execute on function public.contacts_import(jsonb) from public, anon;
grant execute on function public.contacts_import(jsonb) to authenticated;

-- ===== Favoris (propres à chaque utilisateur) =====
create table if not exists public.contact_favorites (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  contact_id bigint not null references public.contacts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, contact_id)
);
alter table public.contact_favorites enable row level security;
do $$ begin
  create policy "contact_favorites: own" on public.contact_favorites for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid() and (select public.has_tool('contacts')));
exception when duplicate_object then null; end $$;
revoke all on public.contact_favorites from anon;
grant select, insert, delete on public.contact_favorites to authenticated;
revoke truncate, references, trigger, update on public.contact_favorites from authenticated;
