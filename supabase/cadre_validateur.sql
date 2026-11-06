-- Médecin cadre : « validateur des absences » devient un réglage par cadre (tous les cadres ne valident pas).
-- Seuls les cadres cochés peuvent être désignés par clinique (page /admin/absences.html) et décider des absences.
-- À exécuter après absences.sql et cadre_medecin.sql. Sans danger si relancé.

alter table public.profiles add column if not exists absence_validator boolean not null default false;
-- Un cadre déjà désigné pour une clinique garde son droit : sa case est cochée
update public.profiles p set absence_validator = true where p.role = 'cadre' and not p.absence_validator
  and exists (select 1 from public.absence_validators av where av.user_id = p.id);

-- ===== Droit de valider : médecin cadre coché ET désigné pour une clinique du membre =====
create or replace function public.can_validate_absence(p_validator uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles v where v.id = p_validator and v.role = 'admin')
      or (p_validator <> p_user
          and public.tool_allowed(p_validator, 'absences')
          and exists (select 1 from public.absence_validators av
                      join public.profiles v on v.id = av.user_id and v.role = 'cadre' and v.absence_validator
                      where av.user_id = p_validator and av.clinic = any (public.member_clinics(p_user))));
$$;

create or replace function public.absence_validator_ids(p_user uuid) returns uuid[] language sql stable security definer set search_path = public as $$
  with cadres as (
    select distinct av.user_id from public.absence_validators av
    join public.profiles v on v.id = av.user_id and v.role = 'cadre' and v.absence_validator
    where av.clinic = any (public.member_clinics(p_user)) and av.user_id <> p_user and public.tool_allowed(av.user_id, 'absences')
  )
  select coalesce(
    nullif((select array_agg(user_id) from cadres), '{}'),
    (select array_agg(id) from public.profiles where role = 'admin' and id <> p_user),
    '{}');
$$;
revoke execute on function public.can_validate_absence(uuid, uuid), public.absence_validator_ids(uuid) from public, anon, authenticated;
grant execute on function public.absence_validator_ids(uuid) to service_role;

create or replace function public.absence_context() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text; v text[];
begin
  perform public.absence_guard();
  select role into r from public.profiles where id = uid;
  v := case when r = 'admin' then array(select clinic from public.absence_clinic_settings order by pos)
            else array(select av.clinic from public.absence_validators av join public.absence_clinic_settings s using (clinic)
                       where av.user_id = uid and r = 'cadre' and exists (select 1 from public.profiles q where q.id = uid and q.absence_validator)
                       order by s.pos) end;
  return jsonb_build_object('me', uid, 'role', r, 'clinics', public.member_clinics(uid), 'validates', to_jsonb(v), 'pending', public.absence_pending_count());
end;
$$;

-- ===== Administration =====
-- Cadres proposés dans le choix des valideurs par clinique : seulement les cadres cochés
create or replace function public.admin_absence_config() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'clinics', coalesce((select jsonb_agg(jsonb_build_object(
        'clinic', s.clinic, 'max_absent', s.max_absent,
        'validators', coalesce((select jsonb_agg(av.user_id) from public.absence_validators av where av.clinic = s.clinic), '[]'::jsonb),
        'members', (select count(*) from public.profiles p where p.role <> 'member' and s.clinic = any (public.member_clinics(p.id))))
        order by s.pos) from public.absence_clinic_settings s), '[]'::jsonb),
    'cadres', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id)) order by lower(public.member_name(p.id)))
                        from public.profiles p where p.role = 'cadre' and p.absence_validator), '[]'::jsonb),
    'cadres_sans_validation', (select count(*) from public.profiles p where p.role = 'cadre' and not p.absence_validator));
end;
$$;

create or replace function public.admin_set_absence_validators(p_clinic text, p_users uuid[]) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare bad uuid;
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  if not exists (select 1 from public.absence_clinic_settings where clinic = p_clinic) then raise exception 'Clinique inconnue : %', p_clinic; end if;
  select u into bad from unnest(coalesce(p_users, '{}')) u
    where not exists (select 1 from public.profiles p where p.id = u and p.role = 'cadre' and p.absence_validator) limit 1;
  if bad is not null then raise exception 'Seuls les médecins cadres cochés « validateur des absences » peuvent valider des absences.'; end if;
  delete from public.absence_validators where clinic = p_clinic;
  insert into public.absence_validators (clinic, user_id) select p_clinic, u from (select distinct u from unnest(coalesce(p_users, '{}')) u) x;
  return array(select user_id from public.absence_validators where clinic = p_clinic);
end;
$$;

-- Case « validateur des absences » d'un médecin cadre ; la décocher le retire de toutes les cliniques
create or replace function public.admin_set_absence_validator(p_user uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r <> 'cadre' then raise exception 'Réservé aux médecins cadres.'; end if;
  update public.profiles set absence_validator = coalesce(p_on, false) where id = p_user;
  if not coalesce(p_on, false) then delete from public.absence_validators where user_id = p_user; end if;
  return coalesce(p_on, false);
end;
$$;

drop function if exists public.admin_members();
create or replace function public.admin_members()
returns table (id uuid, email text, first_name text, last_name text, full_name text, role text, institution text,
               created_at timestamptz, last_sign_in_at timestamptz, tools jsonb, cdc_clinics text[], clinics text[],
               absence_validator boolean, validates text[])
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
       from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'absences', 'medletters']) t),
      p.cdc_clinics, p.clinics, p.absence_validator,
      array(select av.clinic from public.absence_validators av join public.absence_clinic_settings s using (clinic) where av.user_id = p.id order by s.pos)
    from public.profiles p join auth.users u on u.id = p.id
    order by (p.role = 'member') desc, lower(coalesce(p.last_name, p.full_name, u.email));
end;
$$;

create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  if p_role not in ('member', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'admin') then
    raise exception 'Rôle inconnu : %', p_role;
  end if;
  update public.profiles set role = p_role,
    cdc_clinics = case when p_role in ('cdc', 'cadre') then cdc_clinics else '{}' end,
    clinics = case when p_role in ('clinician', 'cdc', 'cadre') then clinics else '{}' end,
    absence_validator = case when p_role = 'cadre' then absence_validator else false end
    where id = p_user;
  if not found then raise exception 'Membre introuvable.'; end if;
  if p_role <> 'cadre' then delete from public.absence_validators where user_id = p_user; end if;
  delete from public.tool_access where user_id = p_user;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['absence_context()', 'admin_absence_config()', 'admin_set_absence_validators(text, uuid[])',
                           'admin_set_absence_validator(uuid, boolean)', 'admin_members()', 'admin_set_role(uuid, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
