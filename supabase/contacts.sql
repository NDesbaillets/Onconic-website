-- Annuaire des médecins (contacts internes CHUV et externes) : personnes et services, numéros complets, recherche libre.
-- Visible des médecins, pharmaciens et admins (outil « contacts »). Tout utilisateur de l'outil peut ajouter et modifier une fiche ;
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
    when 'annuaire' then r in ('clinician', 'assistant', 'pharmacist')
    when 'contacts' then r in ('clinician', 'pharmacist')
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
  detail text check (char_length(detail) <= 200),      -- fonction, plage horaire, précision (garde nuit/WE, cadre, CDC…)
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
