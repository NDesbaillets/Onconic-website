-- Onconic : schéma de base de données Supabase.
-- À exécuter dans Supabase > SQL Editor > New query > Run. Peut être relancé sans risque.

-- 1. Profils et rôles ---------------------------------------------------------
-- Rôles : member (compte créé, pas encore validé), clinician, assistant, pharmacist, admin.
-- pharmacist : droits d'un médecin et d'une assistante réunis, et administration des outils
-- Lettres d'assurance, Limitations LS et Durée de traitement (voir is_app_admin).
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'member'
    check (role in ('member', 'clinician', 'assistant', 'pharmacist', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Fonction utilitaire : rôle de l'utilisateur connecté
create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Ajout du rôle pharmacist sur une base déjà créée
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('member', 'clinician', 'assistant', 'pharmacist', 'admin'));

-- Administration des outils Lettres d'assurance, Limitations LS et Durée de traitement : admin et pharmacien
create or replace function public.is_app_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() in ('admin', 'pharmacist'), false);
$$;
revoke execute on function public.is_app_admin() from public, anon;
grant execute on function public.is_app_admin() to authenticated;

-- Accès par outil : droits par défaut selon le rôle (et l'institution), exceptions individuelles posées par l'admin
-- depuis /admin/membres.html. Outils : congres, trials, lettres, limitations, duree, medletters.
create table if not exists public.tool_access (
  user_id uuid not null references auth.users (id) on delete cascade,
  tool text not null check (tool in ('congres', 'trials', 'lettres', 'limitations', 'duree')),
  allowed boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, tool)
);
alter table public.tool_access enable row level security;
drop policy if exists "tool_access: admin read" on public.tool_access;
create policy "tool_access: admin read" on public.tool_access for select to authenticated
  using (public.current_role_name() = 'admin');
revoke all on public.tool_access from anon;
revoke insert, update, delete, truncate on public.tool_access from authenticated;
grant select on public.tool_access to authenticated;

-- plpgsql : colonnes institution et med_plus ajoutées par d'autres scripts, lues seulement à l'exécution
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
    when 'lettres' then r = 'pharmacist' or (r = 'clinician' and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician') and i = 'CHUV')
    else false end;
end;
$$;
revoke execute on function public.tool_allowed(uuid, text) from public, anon, authenticated;

create or replace function public.has_tool(p_tool text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.tool_allowed(auth.uid(), p_tool);
$$;
revoke execute on function public.has_tool(text) from public, anon;
grant execute on function public.has_tool(text) to authenticated;

create or replace function public.my_tools()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t), '{}') from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters']) t
  where public.tool_allowed(auth.uid(), t);
$$;
revoke execute on function public.my_tools() from public, anon;
grant execute on function public.my_tools() to authenticated;

-- Administration d'un outil (import, textes) : admin, ou pharmacien qui a accès à cet outil
create or replace function public.is_app_admin(p_tool text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() = 'admin'
    or (public.current_role_name() = 'pharmacist' and public.tool_allowed(auth.uid(), p_tool)), false);
$$;
revoke execute on function public.is_app_admin(text) from public, anon;
grant execute on function public.is_app_admin(text) to authenticated;

-- Chacun lit son propre profil ; l'admin lit tout.
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select using (id = auth.uid() or public.current_role_name() = 'admin');

-- Seul l'admin modifie les rôles (un membre ne peut pas s'auto-promouvoir).
drop policy if exists "profiles: admin update" on public.profiles;
create policy "profiles: admin update" on public.profiles
  for update using (public.current_role_name() = 'admin');

-- Création automatique du profil à l'inscription / invitation
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Formulaire de contact ----------------------------------------------------
-- Les demandes arrivent uniquement par l'Edge Function contact-request (clé service_role),
-- qui notifie les admins. Aucune écriture directe depuis le site.
create table if not exists public.contact_requests (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('join', 'business', 'other')),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 200),
  organisation text check (char_length(organisation) <= 200),
  message text not null check (char_length(message) between 1 and 4000),
  lang text check (lang in ('en', 'fr')),
  created_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'invited', 'declined')),
  handled_role text check (handled_role in ('clinician', 'assistant', 'pharmacist')),
  handled_at timestamptz
);

create index if not exists contact_requests_email_created_idx on public.contact_requests (email, created_at);
alter table public.contact_requests drop constraint if exists contact_requests_handled_role_check;
alter table public.contact_requests add constraint contact_requests_handled_role_check
  check (handled_role in ('clinician', 'assistant', 'pharmacist'));

alter table public.contact_requests enable row level security;

drop policy if exists "contact: anyone can submit" on public.contact_requests;

drop policy if exists "contact: admin reads" on public.contact_requests;
create policy "contact: admin reads" on public.contact_requests
  for select using (public.current_role_name() = 'admin');

-- Droits d'accès explicites (les règles RLS ci-dessus filtrent ensuite ligne par ligne)
grant usage on schema public to anon, authenticated;
grant select on public.contact_requests to authenticated;
grant select, update on public.profiles to authenticated;
-- Les visiteurs anonymes n'ont rien à lire ; la fonction du déclencheur n'est pas appelable via l'API
revoke select on public.profiles from anon;
revoke select on public.contact_requests from anon;
revoke insert, update, delete on public.contact_requests from anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- 3. Documents de formation (PDF, slides) -------------------------------------
-- Bucket privé : les fichiers ne sont jamais publics, seulement servis aux membres validés.
insert into storage.buckets (id, name, public)
values ('hive', 'hive', false)
on conflict (id) do nothing;

drop policy if exists "hive files: validated members read" on storage.objects;
create policy "hive files: validated members read" on storage.objects
  for select to authenticated
  using (bucket_id = 'hive' and public.current_role_name() in ('clinician', 'assistant', 'pharmacist', 'admin'));

drop policy if exists "hive files: admin writes" on storage.objects;
create policy "hive files: admin writes" on storage.objects
  for all to authenticated
  using (bucket_id = 'hive' and public.current_role_name() = 'admin')
  with check (bucket_id = 'hive' and public.current_role_name() = 'admin');
