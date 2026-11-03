-- Annuaire des prestataires (imagerie, laboratoires, cabinets, CMS, soins à domicile…).
-- Visible des médecins, assistantes, pharmaciens et admins. Tout utilisateur peut ajouter et modifier une fiche ;
-- la suppression est réservée à l'auteur de la fiche et aux admins ; import Excel réservé aux admins.
-- À exécuter après schema.sql et admin.sql, avant de déployer le site qui l'utilise. Sans danger si relancé.

-- ===== Accès à l'outil « annuaire » : rôles médecin, assistante, pharmacien (admin : toujours) =====
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
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician') and i = 'CHUV')
    else false end;
end;
$$;

create or replace function public.my_tools()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t), '{}') from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters', 'annuaire']) t
  where public.tool_allowed(auth.uid(), t);
$$;

-- ===== Prestataires =====
create table if not exists public.providers (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 2 and 200),
  scope text not null check (scope in ('interne', 'externe')),
  category text not null check (category in ('imagerie', 'laboratoire', 'cabinet', 'autre')),
  subtype text check (char_length(subtype) <= 100),     -- précision libre : CMS, soins à domicile, IRM, médecin généraliste…
  address text check (char_length(address) <= 300),
  phone text check (char_length(phone) <= 40),          -- numéro rapide
  phone_alt text check (char_length(phone_alt) <= 100), -- autre numéro (urgences, après-heures, fax…)
  email text check (char_length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  website text check (char_length(website) <= 300 and website ~ '^https?://'),
  contact text check (char_length(contact) <= 200),     -- personne ou service de contact
  notes text check (char_length(notes) <= 1000),        -- jamais de données de patients
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index if not exists providers_unique on public.providers (lower(name), lower(coalesce(address, '')));
create index if not exists providers_name on public.providers (lower(name));

create or replace function public.providers_stamp()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end;
$$;
create or replace trigger providers_stamp before update on public.providers
  for each row execute function public.providers_stamp();

alter table public.providers enable row level security;
do $$ begin
  create policy "providers: read" on public.providers for select to authenticated using ((select public.has_tool('annuaire')));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "providers: insert" on public.providers for insert to authenticated
    with check ((select public.has_tool('annuaire')) and created_by = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "providers: update" on public.providers for update to authenticated
    using ((select public.has_tool('annuaire'))) with check ((select public.has_tool('annuaire')));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "providers: delete" on public.providers for delete to authenticated
    using ((select public.is_app_admin('annuaire')) or ((select public.has_tool('annuaire')) and created_by = auth.uid()));
exception when duplicate_object then null; end $$;
revoke all on public.providers from anon;
grant select, insert, update, delete on public.providers to authenticated;
-- Les droits par défaut de Supabase incluent aussi TRUNCATE, REFERENCES et TRIGGER : on ne garde que le nécessaire
revoke truncate, references, trigger on public.providers from authenticated;

-- ===== Favoris (propres à chaque utilisateur) =====
create table if not exists public.provider_favorites (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider_id bigint not null references public.providers (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, provider_id)
);
alter table public.provider_favorites enable row level security;
do $$ begin
  create policy "provider_favorites: own" on public.provider_favorites for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid() and (select public.has_tool('annuaire')));
exception when duplicate_object then null; end $$;
revoke all on public.provider_favorites from anon;
grant select, insert, delete on public.provider_favorites to authenticated;
revoke truncate, references, trigger, update on public.provider_favorites from authenticated;

-- ===== Import Excel (admin) : ajoute les nouvelles fiches et met à jour celles de même nom et même adresse ; ne supprime rien =====
create or replace function public.providers_import(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_new int := 0; n_upd int := 0; r record; was_new boolean;
begin
  if not public.is_app_admin('annuaire') then
    raise exception 'admin only' using errcode = '42501';
  end if;
  for r in
    select nullif(trim(x.name), '') as name, lower(trim(x.scope)) as scope, lower(trim(x.category)) as category,
      nullif(trim(x.subtype), '') as subtype, nullif(trim(x.address), '') as address, nullif(trim(x.phone), '') as phone,
      nullif(trim(x.phone_alt), '') as phone_alt, nullif(trim(x.email), '') as email, nullif(trim(x.website), '') as website,
      nullif(trim(x.contact), '') as contact, nullif(trim(x.notes), '') as notes
    from jsonb_to_recordset(p_rows) as x(name text, scope text, category text, subtype text, address text, phone text,
      phone_alt text, email text, website text, contact text, notes text)
  loop
    insert into public.providers (name, scope, category, subtype, address, phone, phone_alt, email, website, contact, notes)
    values (r.name, r.scope, r.category, r.subtype, r.address, r.phone, r.phone_alt, r.email, r.website, r.contact, r.notes)
    on conflict (lower(name), lower(coalesce(address, ''))) do update set
      scope = excluded.scope, category = excluded.category,
      subtype = coalesce(excluded.subtype, public.providers.subtype), phone = coalesce(excluded.phone, public.providers.phone),
      phone_alt = coalesce(excluded.phone_alt, public.providers.phone_alt), email = coalesce(excluded.email, public.providers.email),
      website = coalesce(excluded.website, public.providers.website), contact = coalesce(excluded.contact, public.providers.contact),
      notes = coalesce(excluded.notes, public.providers.notes)
    returning (xmax = 0) into was_new;
    if was_new then n_new := n_new + 1; else n_upd := n_upd + 1; end if;
  end loop;
  return jsonb_build_object('inserted', n_new, 'updated', n_upd);
end;
$$;
revoke execute on function public.providers_import(jsonb) from public, anon;
grant execute on function public.providers_import(jsonb) to authenticated;
