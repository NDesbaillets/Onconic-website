-- Onconic : schéma de base de données Supabase.
-- À exécuter une seule fois dans Supabase > SQL Editor > New query > Run.

-- 1. Profils et rôles ---------------------------------------------------------
-- Rôles : member (compte créé, pas encore validé), clinician, assistant, admin.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'member'
    check (role in ('member', 'clinician', 'assistant', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Fonction utilitaire : rôle de l'utilisateur connecté
create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Chacun lit son propre profil ; l'admin lit tout.
create policy "profiles: read own" on public.profiles
  for select using (id = auth.uid() or public.current_role_name() = 'admin');

-- Seul l'admin modifie les rôles (un membre ne peut pas s'auto-promouvoir).
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
-- Les visiteurs anonymes peuvent écrire, jamais lire.
create table if not exists public.contact_requests (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('join', 'business', 'other')),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 200),
  organisation text check (char_length(organisation) <= 200),
  message text not null check (char_length(message) between 1 and 4000),
  lang text check (lang in ('en', 'fr')),
  created_at timestamptz not null default now()
);

alter table public.contact_requests enable row level security;

create policy "contact: anyone can submit" on public.contact_requests
  for insert to anon, authenticated with check (true);

create policy "contact: admin reads" on public.contact_requests
  for select using (public.current_role_name() = 'admin');

-- 3. Documents de formation (PDF, slides) -------------------------------------
-- Bucket privé : les fichiers ne sont jamais publics, seulement servis aux membres validés.
insert into storage.buckets (id, name, public)
values ('hive', 'hive', false)
on conflict (id) do nothing;

create policy "hive files: validated members read" on storage.objects
  for select to authenticated
  using (bucket_id = 'hive' and public.current_role_name() in ('clinician', 'assistant', 'admin'));

create policy "hive files: admin writes" on storage.objects
  for all to authenticated
  using (bucket_id = 'hive' and public.current_role_name() = 'admin')
  with check (bucket_id = 'hive' and public.current_role_name() = 'admin');
