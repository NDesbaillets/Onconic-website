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
