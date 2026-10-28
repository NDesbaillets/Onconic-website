-- Onconic : données personnelles modifiables par chaque membre (page « Mon compte »).
-- À exécuter une fois dans Supabase > SQL Editor > Run (peut être relancé sans risque).

alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name text;
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists phone text;

alter table public.profiles drop constraint if exists profiles_first_name_len;
alter table public.profiles add constraint profiles_first_name_len check (char_length(first_name) <= 80);
alter table public.profiles drop constraint if exists profiles_last_name_len;
alter table public.profiles add constraint profiles_last_name_len check (char_length(last_name) <= 80);
alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format check (username ~ '^[a-z0-9._-]{3,30}$');
alter table public.profiles drop constraint if exists profiles_phone_format;
alter table public.profiles add constraint profiles_phone_format check (phone ~ '^\+?[0-9 ().-]{6,20}$');
create unique index if not exists profiles_username_unique on public.profiles (lower(username));

-- Chaque membre modifie sa propre ligne, et seulement ses champs personnels
-- (le rôle et l'institution restent réservés à l'administration).
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (first_name, last_name, username, phone, full_name) on public.profiles to authenticated;

-- Changement d'adresse e-mail : l'institution CHUV suit l'adresse vérifiée
create or replace function public.handle_user_email_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) like '%@chuv.ch' then
    update public.profiles set institution = 'CHUV' where id = new.id;
  elsif lower(old.email) like '%@chuv.ch' then
    update public.profiles set institution = null where id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.handle_user_email_change() from public, anon, authenticated;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();
