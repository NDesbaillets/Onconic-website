-- Key trials : fiches visibles par tous (brouillons compris), rôle « CDC / Cadre » limité à des cliniques,
-- signalement « à réviser » avec commentaire.
-- À exécuter après schema.sql, admin.sql, trials.sql, annuaire.sql et contacts.sql. Sans danger si relancé.

-- ===== 1. Rôle « cdc » (CDC / Cadre) : droits d'un médecin + gestion des fiches Key trials de ses cliniques =====
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('member', 'clinician', 'cdc', 'assistant', 'pharmacist', 'admin'));
alter table public.profiles add column if not exists cdc_clinics text[] not null default '{}';

create or replace function public.tool_allowed(p_user uuid, p_tool text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; i text; m boolean; o boolean;
begin
  select role, institution, med_plus into r, i, m from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if r = 'admin' then return true; end if;
  -- Lettres médicales : accès « médecin plus », attribué un par un
  if p_tool = 'medletters' then return r in ('clinician', 'cdc', 'pharmacist') and coalesce(m, false); end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'congres' then r in ('clinician', 'cdc', 'assistant', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'assistant', 'pharmacist')
    when 'annuaire' then r in ('clinician', 'cdc', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'cdc', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'cdc', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'cdc', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician', 'cdc') and i = 'CHUV')
    else false end;
end;
$$;

create or replace function public.is_hive_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() in ('admin', 'clinician', 'cdc', 'assistant', 'pharmacist'), false);
$$;

drop policy if exists "hive files: validated members read" on storage.objects;
create policy "hive files: validated members read" on storage.objects
  for select to authenticated
  using (bucket_id = 'hive' and public.current_role_name() in ('clinician', 'cdc', 'assistant', 'pharmacist', 'admin'));

create or replace function public.medletters_members()
returns table (id uuid, name text, institution text, med_plus boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select p.id, coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), p.full_name, '(sans nom)'),
           p.institution, p.med_plus
    from public.profiles p where p.role in ('clinician', 'cdc', 'pharmacist') order by 2;
end;
$$;

create or replace function public.medletters_set_access(p_user uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  update public.profiles set med_plus = p_on where id = p_user and role in ('clinician', 'cdc', 'pharmacist');
end;
$$;

-- Administration des membres : rôle cdc et choix de ses cliniques
drop function if exists public.admin_members();
create or replace function public.admin_members()
returns table (id uuid, email text, first_name text, last_name text, full_name text, role text, institution text,
               created_at timestamptz, last_sign_in_at timestamptz, tools jsonb, cdc_clinics text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select p.id, u.email::text, p.first_name, p.last_name, p.full_name, p.role, p.institution, u.created_at, u.last_sign_in_at,
      (select jsonb_object_agg(t, jsonb_build_object(
          'allowed', public.tool_allowed(p.id, t),
          'custom', exists (select 1 from public.tool_access a where a.user_id = p.id and a.tool = t)))
       from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters']) t),
      p.cdc_clinics
    from public.profiles p join auth.users u on u.id = p.id
    order by (p.role = 'member') desc, lower(coalesce(p.last_name, p.full_name, u.email));
end;
$$;
revoke execute on function public.admin_members() from public, anon;
grant execute on function public.admin_members() to authenticated;

create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  if p_role not in ('member', 'clinician', 'cdc', 'assistant', 'pharmacist', 'admin') then
    raise exception 'Rôle inconnu : %', p_role;
  end if;
  update public.profiles set role = p_role, cdc_clinics = case when p_role = 'cdc' then cdc_clinics else '{}' end where id = p_user;
  if not found then raise exception 'Membre introuvable.'; end if;
  delete from public.tool_access where user_id = p_user;
end;
$$;

create or replace function public.admin_set_tool(p_user uuid, p_tool text, p_allowed boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r in ('admin', 'member') then raise exception 'Accès fixé par le rôle (%)', r; end if;
  if p_tool = 'medletters' then
    if p_allowed and r not in ('clinician', 'cdc', 'pharmacist') then
      raise exception 'Lettres médicales : réservé aux médecins et pharmaciens.';
    end if;
    update public.profiles set med_plus = p_allowed where id = p_user;
  elsif p_tool in ('congres', 'trials', 'lettres', 'limitations', 'duree') then
    delete from public.tool_access where user_id = p_user and tool = p_tool;
    if public.tool_allowed(p_user, p_tool) is distinct from p_allowed then
      insert into public.tool_access (user_id, tool, allowed) values (p_user, p_tool, p_allowed);
    end if;
  else
    raise exception 'Outil inconnu : %', p_tool;
  end if;
  return public.tool_allowed(p_user, p_tool);
end;
$$;

-- Cliniques gérées par un membre CDC / Cadre (une ou plusieurs)
create or replace function public.admin_set_cdc_clinics(p_user uuid, p_clinics text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare r text; bad text;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is distinct from 'cdc' then raise exception 'Réservé aux membres du rôle CDC / Cadre.'; end if;
  select c into bad from unnest(coalesce(p_clinics, '{}')) c
    where c not in ('Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome',
                    'Lower GI', 'Upper GI', 'ORL', 'Sarcomes', 'Radiologie interventionnelle') limit 1;
  if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
  update public.profiles set cdc_clinics = coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}')) c order by c), '{}')
    where id = p_user;
  return (select cdc_clinics from public.profiles where id = p_user);
end;
$$;
revoke execute on function public.admin_set_cdc_clinics(uuid, text[]) from public, anon;
grant execute on function public.admin_set_cdc_clinics(uuid, text[]) to authenticated;

-- ===== 2. Droit de modifier les fiches Key trials : admin, ou CDC / Cadre de la clinique de la fiche =====
create or replace function public.can_edit_trials(p_clinic text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'admin' or (p.role = 'cdc' and p_clinic is not null and p_clinic = any (p.cdc_clinics))
                   from public.profiles p where p.id = auth.uid()), false);
$$;
revoke execute on function public.can_edit_trials(text) from public, anon;
grant execute on function public.can_edit_trials(text) to authenticated;

-- Toutes les fiches (brouillons compris) sont lisibles par les membres qui ont l'outil ; l'écriture suit la clinique
drop policy if exists "key_trials: members read published" on public.key_trials;
drop policy if exists "key_trials: members read" on public.key_trials;
create policy "key_trials: members read" on public.key_trials for select to authenticated
  using ((select public.has_tool('trials')) or public.current_role_name() = 'admin');
drop policy if exists "key_trials: admin write" on public.key_trials;
drop policy if exists "key_trials: editors insert" on public.key_trials;
create policy "key_trials: editors insert" on public.key_trials for insert to authenticated
  with check (public.can_edit_trials(clinic));
drop policy if exists "key_trials: editors update" on public.key_trials;
create policy "key_trials: editors update" on public.key_trials for update to authenticated
  using (public.can_edit_trials(clinic)) with check (public.can_edit_trials(clinic));
drop policy if exists "key_trials: admin delete" on public.key_trials;
create policy "key_trials: admin delete" on public.key_trials for delete to authenticated
  using (public.current_role_name() = 'admin');
revoke truncate, references, trigger on public.key_trials from authenticated;

-- ===== 3. Signalement « à réviser » avec commentaire =====
create table if not exists public.trial_flags (
  id bigint generated always as identity primary key,
  trial_id bigint not null references public.key_trials (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_name text,
  comment text not null check (char_length(comment) between 5 and 1000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_name text
);
create index if not exists trial_flags_open on public.trial_flags (trial_id) where resolved_at is null;

create or replace function public.trial_flags_fill()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.author_name := (select coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), p.full_name, 'Membre') from public.profiles p where p.id = new.user_id);
  elsif new.resolved_at is not null and old.resolved_at is null then
    new.resolved_by := auth.uid();
    new.resolved_name := (select coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), p.full_name, 'Membre') from public.profiles p where p.id = auth.uid());
  end if;
  return new;
end;
$$;
create or replace trigger trial_flags_fill before insert or update on public.trial_flags
  for each row execute function public.trial_flags_fill();

-- Peut relire / traiter les signalements de cette fiche : admin ou CDC de sa clinique
create or replace function public.can_review_trial(p_trial bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_edit_trials((select clinic from public.key_trials where id = p_trial));
$$;
revoke execute on function public.can_review_trial(bigint) from public, anon;
grant execute on function public.can_review_trial(bigint) to authenticated;

alter table public.trial_flags enable row level security;
drop policy if exists "trial_flags: read" on public.trial_flags;
create policy "trial_flags: read" on public.trial_flags for select to authenticated
  using (user_id = auth.uid() or public.can_review_trial(trial_id));
drop policy if exists "trial_flags: insert" on public.trial_flags;
create policy "trial_flags: insert" on public.trial_flags for insert to authenticated
  with check (user_id = auth.uid() and resolved_at is null and (select public.has_tool('trials')));
drop policy if exists "trial_flags: resolve" on public.trial_flags;
create policy "trial_flags: resolve" on public.trial_flags for update to authenticated
  using (public.can_review_trial(trial_id)) with check (public.can_review_trial(trial_id));
drop policy if exists "trial_flags: admin delete" on public.trial_flags;
create policy "trial_flags: admin delete" on public.trial_flags for delete to authenticated
  using (public.current_role_name() = 'admin');
revoke all on public.trial_flags from anon;
grant select, insert, delete on public.trial_flags to authenticated;
grant update (resolved_at) on public.trial_flags to authenticated;
