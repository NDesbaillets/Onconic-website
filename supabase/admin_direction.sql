-- Onconic : rôle « Admin de direction » (profiles.role = 'direction').
-- À exécuter en dernier, après absences_forms.sql et absences_cliniques_datees.sql. Sans danger si relancé.
--
-- Ce que fait la direction
--  * Gestion des membres comme l'administrateur : rôles, cliniques, validateurs des absences, changements de bloc programmés,
--    accès par outil. Garde-fous : elle ne peut ni donner le rôle admin ou direction, ni modifier un compte admin ou direction.
--  * Gestion du calendrier commun et des deux annuaires (médecins, prestataires), import compris.
--  * Validation des absences en 1re ligne (si désignée validatrice d'une clinique, comme un cadre) et en 2e ligne : quand tous les
--    validateurs de la clinique ont validé, la demande attend le visa de la direction (absences.stage = 2). Un seul visa suffit.
--    Sans validateur de clinique, la demande passe directement en 2e ligne. S'il n'y a aucun membre « direction », les admins
--    tiennent ce rôle. L'admin peut toujours trancher seul.
--  * Ajout, modification et annulation d'absences au nom d'un membre, validées d'office (absence_direction_*).
-- Ne donne pas : administration des rôles admin/direction, Lettres d'assurance, Limitations LS, Durée de traitement, Key trials, Formation.

-- ===== 1. Rôle, colonnes, boîte d'envoi =====
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('member', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'direction', 'admin'));

alter table public.absences add column if not exists stage smallint not null default 1;
alter table public.absences drop constraint if exists absences_stage_check;
alter table public.absences add constraint absences_stage_check check (stage in (1, 2));
alter table public.absences add column if not exists direction_by uuid references auth.users (id) on delete set null;
alter table public.absences add column if not exists direction_at timestamptz;
-- Les demandes déjà en cours sans validateur de clinique attendent directement la décision de la direction (ou des admins)
update public.absences a set stage = 2
  where (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null)) and a.stage = 1
    and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id);

alter table public.absence_outbox drop constraint if exists absence_outbox_kind_check;
alter table public.absence_outbox add constraint absence_outbox_kind_check
  check (kind in ('to_validate', 'to_validate_change', 'approved', 'rejected', 'change_approved', 'change_rejected', 'form', 'to_direction', 'direction_change'));

-- ===== 2. Fonctions de base =====
create or replace function public.is_direction_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() in ('admin', 'direction'), false);
$$;
revoke execute on function public.is_direction_admin() from public, anon;
grant execute on function public.is_direction_admin() to authenticated;

-- Membres qui tiennent le rôle de 2e ligne : les « direction » ; à défaut, les admins
create or replace function public.absence_direction_recipients(p_exclude uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(array(select p.id from public.profiles p where p.role = 'direction' and p.id is distinct from p_exclude and public.tool_allowed(p.id, 'absences')), '{}'::uuid[]),
    array(select p.id from public.profiles p where p.role = 'admin' and p.id is distinct from p_exclude),
    '{}'::uuid[]);
$$;

-- Cette demande attend-elle une décision de ce membre ? (1re ligne : validateur désigné qui n'a pas encore validé ; 2e ligne : direction)
create or replace function public.absence_actionable(p_uid uuid, a public.absences) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_uid is null or not public.tool_allowed(p_uid, 'absences') then false
    when (select role from public.profiles where id = p_uid) = 'admin' then true
    when a.stage = 2 then (select role from public.profiles where id = p_uid) = 'direction' and p_uid <> a.user_id
    else public.can_validate_absence(p_uid, a.user_id, public.absence_lo(a), public.absence_hi(a))
         and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.validator_id = p_uid and p.decision = 'approved')
  end;
$$;
revoke execute on function public.absence_direction_recipients(uuid), public.absence_actionable(uuid, public.absences) from public, anon, authenticated;

-- Un message « à la direction » par absence mais regroupé : s'il en attend déjà un non envoyé pour ce membre, on l'étoffe
create or replace function public.absence_enqueue_direction(p_ids bigint[], p_owner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid; oid bigint;
begin
  foreach r in array public.absence_direction_recipients(p_owner) loop
    select id into oid from public.absence_outbox
      where kind = 'to_direction' and recipient = r and sent_at is null and claimed_at is null
        and payload ->> 'owner_id' = p_owner::text and created_at > now() - interval '10 minutes'
      order by id desc limit 1;
    if oid is not null then
      update public.absence_outbox set absence_ids = array(select distinct x from unnest(absence_ids || p_ids) x order by x) where id = oid;
    else
      insert into public.absence_outbox (kind, recipient, absence_ids, payload)
        values ('to_direction', r, p_ids, jsonb_build_object('owner', public.member_name(p_owner), 'owner_id', p_owner));
    end if;
  end loop;
end;
$$;
revoke execute on function public.absence_enqueue_direction(bigint[], uuid) from public, anon, authenticated;

-- ===== 3. Rôles, accès, cliniques =====
create or replace function public.tool_allowed(p_user uuid, p_tool text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; i text; m boolean; o boolean;
begin
  select role, institution, med_plus into r, i, m from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if r = 'admin' then return true; end if;
  if r = 'direction' then return p_tool in ('absences', 'congres', 'formation', 'annuaire', 'contacts'); end if;
  if p_tool = 'medletters' then return r in ('clinician', 'cdc', 'cadre', 'pharmacist') and coalesce(m, false); end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'absences' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'congres' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'formation' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'annuaire' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'cdc', 'cadre', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician', 'cdc', 'cadre') and i = 'CHUV')
    else false end;
end;
$$;

-- Administration d'un outil (import, textes) : admin ; pharmacien qui a accès à l'outil ; direction pour les deux annuaires seulement
create or replace function public.is_app_admin(p_tool text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() = 'admin'
    or (public.current_role_name() = 'pharmacist' and public.tool_allowed(auth.uid(), p_tool))
    or (public.current_role_name() = 'direction' and p_tool in ('annuaire', 'contacts')), false);
$$;

create or replace function public.member_clinics(p_user uuid, p_from date, p_to date) returns text[]
language sql stable security definer set search_path = public as $$
  with ch as (
    select c.valid_from, c.clinics, lead(c.valid_from) over (order by c.valid_from) as nxt
    from public.member_clinic_changes c where c.user_id = p_user
  )
  select coalesce((
    select case
      when p.role in ('clinician', 'cdc', 'cadre') then coalesce(array(
        select distinct x from (
          select unnest(p.clinics) as x where not exists (select 1 from ch where ch.valid_from <= p_from)
          union all
          select unnest(ch.clinics) from ch where ch.valid_from <= p_to and (ch.nxt is null or ch.nxt > p_from)
        ) s order by x), '{}')
      when p.role in ('assistant', 'pharmacist', 'direction', 'admin') then array['Administration']
      else '{}'::text[] end
    from public.profiles p where p.id = p_user), '{}'::text[]);
$$;

create or replace function public.admin_members()
returns table (id uuid, email text, first_name text, last_name text, full_name text, role text, institution text,
               created_at timestamptz, last_sign_in_at timestamptz, tools jsonb, cdc_clinics text[], clinics text[],
               absence_validator boolean, validates text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then
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

-- Changement de rôle (jamais le sien). La direction ne donne ni le rôle admin ni le rôle direction et ne modifie pas un compte admin ou direction.
create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  if not public.is_direction_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  if p_role not in ('member', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'direction', 'admin') then
    raise exception 'Rôle inconnu : %', p_role;
  end if;
  select role into cur from public.profiles where id = p_user;
  if cur is null then raise exception 'Membre introuvable.'; end if;
  if public.current_role_name() = 'direction' and (p_role in ('admin', 'direction') or cur in ('admin', 'direction')) then
    raise exception 'Seul un administrateur donne ou retire les rôles admin et direction.' using errcode = '42501';
  end if;
  update public.profiles set role = p_role,
    cdc_clinics = case when p_role in ('cdc', 'cadre') then cdc_clinics else '{}' end,
    clinics = case when p_role in ('clinician', 'cdc', 'cadre') then clinics else '{}' end,
    absence_validator = case when p_role in ('cadre', 'direction') then absence_validator else false end
    where id = p_user;
  if p_role not in ('cadre', 'direction') then delete from public.absence_validators where user_id = p_user; end if;
  delete from public.tool_access where user_id = p_user;
  perform public.absence_recheck();
end;
$$;
revoke execute on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

create or replace function public.admin_set_tool(p_user uuid, p_tool text, p_allowed boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if not public.is_direction_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r in ('admin', 'direction', 'member') then raise exception 'Accès fixé par le rôle (%)', r; end if;
  if p_tool = 'medletters' and public.current_role_name() <> 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  if p_tool = 'medletters' then
    if p_allowed and r not in ('clinician', 'cdc', 'cadre', 'pharmacist') then
      raise exception 'Lettres médicales : réservé aux médecins et pharmaciens.';
    end if;
    update public.profiles set med_plus = p_allowed where id = p_user;
  elsif p_tool in ('congres', 'trials', 'lettres', 'limitations', 'duree', 'absences') then
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

create or replace function public.admin_reset_tools(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.tool_access where user_id = p_user;
end;
$$;

create or replace function public.admin_set_cdc_clinics(p_user uuid, p_clinics text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare r text; bad text;
begin
  if not public.is_direction_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is null or r not in ('cdc', 'cadre') then raise exception 'Réservé aux membres du rôle CDC ou Cadre.'; end if;
  select c into bad from unnest(coalesce(p_clinics, '{}')) c
    where c not in ('Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome',
                    'Lower GI', 'Upper GI', 'ORL', 'Sarcomes', 'Rad-Inter', 'ION', 'UTOH') limit 1;
  if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
  update public.profiles set cdc_clinics = coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}')) c order by c), '{}')
    where id = p_user;
  return (select cdc_clinics from public.profiles where id = p_user);
end;
$$;

create or replace function public.admin_set_clinics(p_user uuid, p_clinics text[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare r text; v text[];
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r not in ('clinician', 'cdc', 'cadre') then raise exception 'Seuls les médecins sont rattachés à une clinique.'; end if;
  v := public.clinic_choice_check(p_clinics);
  update public.profiles set clinics = v where id = p_user;
  perform public.absence_reroute(p_user);
  return v;
end;
$$;

create or replace function public.admin_clinic_changes()
returns table (user_id uuid, valid_from date, clinics text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query select c.user_id, c.valid_from, c.clinics from public.member_clinic_changes c
    where c.valid_from > public.ch_today() order by c.user_id, c.valid_from;
end;
$$;

create or replace function public.admin_clinic_change_save(p_user uuid, p_from date, p_clinics text[]) returns void
language plpgsql security definer set search_path = public as $$
declare r text; v text[];
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r not in ('clinician', 'cdc', 'cadre') then raise exception 'Seuls les médecins sont rattachés à une clinique.'; end if;
  if p_from is null or p_from <= public.ch_today() then raise exception 'Choisissez une date postérieure à aujourd''hui (pour aujourd''hui, modifiez les cliniques actuelles).'; end if;
  if p_from > public.ch_today() + 1100 then raise exception 'Date trop lointaine (3 ans au plus).'; end if;
  v := public.clinic_choice_check(p_clinics);
  insert into public.member_clinic_changes (user_id, valid_from, clinics, created_by) values (p_user, p_from, v, auth.uid())
    on conflict (user_id, valid_from) do update set clinics = excluded.clinics, created_by = excluded.created_by, created_at = now();
  perform public.absence_reroute(p_user);
end;
$$;

create or replace function public.admin_clinic_change_delete(p_user uuid, p_from date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.member_clinic_changes where user_id = p_user and valid_from = p_from;
  perform public.absence_reroute(p_user);
end;
$$;

create or replace function public.admin_set_absence_threshold(p_clinic text, p_max int) returns int
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_max is null or p_max < 1 or p_max > 50 then raise exception 'Seuil invalide (1 à 50).'; end if;
  update public.absence_clinic_settings set max_absent = p_max where clinic = p_clinic;
  if not found then raise exception 'Clinique inconnue : %', p_clinic; end if;
  return p_max;
end;
$$;

create or replace function public.admin_calendar_confirm(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.absence_calendar set to_confirm = false where id = p_id;
end;
$$;

create or replace function public.admin_calendar_delete(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.absence_calendar where id = p_id;
end;
$$;

create or replace function public.admin_calendar_list()
returns table (id bigint, kind text, label text, start_date date, end_date date, source text, to_confirm boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query select c.id, c.kind, c.label, c.start_date, c.end_date, c.source, c.to_confirm from public.absence_calendar c order by c.start_date, c.label;
end;
$$;

create or replace function public.admin_calendar_save(p_id bigint, p_kind text, p_label text, p_start date, p_end date) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint; l text := trim(coalesce(p_label, ''));
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_kind not in ('vacances_scolaires', 'evenement') then raise exception 'Type inconnu.'; end if;
  if char_length(l) < 2 or char_length(l) > 120 then raise exception 'Intitulé de 2 à 120 caractères.'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'Vérifiez les dates.'; end if;
  if p_end - p_start > 120 then raise exception 'Période trop longue (120 jours au plus).'; end if;
  if p_id is null then
    insert into public.absence_calendar (kind, label, start_date, end_date) values (p_kind, l, p_start, p_end) returning id into new_id;
  else
    update public.absence_calendar set kind = p_kind, label = l, start_date = p_start, end_date = p_end, to_confirm = false where id = p_id returning id into new_id;
    if new_id is null then raise exception 'Entrée introuvable.'; end if;
  end if;
  return new_id;
end;
$$;

create or replace function public.admin_calendar_sync_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return (select jsonb_build_object('last_run', last_run, 'result', last_result) from public.calendar_sync where id = 1);
end;
$$;

create or replace function public.events_absence_flag_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then
    new.in_absence_calendar := case when tg_op = 'INSERT' then false else old.in_absence_calendar end;
  end if;
  return new;
end;
$$;

create or replace function public.admin_set_absence_validator(p_user uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r not in ('cadre', 'direction') then raise exception 'Réservé aux médecins cadres et à la direction.'; end if;
  update public.profiles set absence_validator = coalesce(p_on, false) where id = p_user;
  if not coalesce(p_on, false) then delete from public.absence_validators where user_id = p_user; end if;
  perform public.absence_recheck();
  return coalesce(p_on, false);
end;
$$;

create or replace function public.admin_set_absence_validators(p_clinic text, p_users uuid[]) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare bad uuid;
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if not exists (select 1 from public.absence_clinic_settings where clinic = p_clinic) then raise exception 'Clinique inconnue : %', p_clinic; end if;
  select u into bad from unnest(coalesce(p_users, '{}')) u
    where not exists (select 1 from public.profiles p where p.id = u and p.role in ('cadre', 'direction') and p.absence_validator) limit 1;
  if bad is not null then raise exception 'Seuls les médecins cadres et la direction cochés « validateur des absences » peuvent valider des absences.'; end if;
  delete from public.absence_validators where clinic = p_clinic;
  insert into public.absence_validators (clinic, user_id) select p_clinic, u from (select distinct u from unnest(coalesce(p_users, '{}')) u) x;
  perform public.absence_recheck();
  return array(select user_id from public.absence_validators where clinic = p_clinic);
end;
$$;

create or replace function public.admin_absence_config() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'clinics', coalesce((select jsonb_agg(jsonb_build_object(
        'clinic', s.clinic, 'max_absent', s.max_absent,
        'validators', coalesce((select jsonb_agg(av.user_id) from public.absence_validators av where av.clinic = s.clinic), '[]'::jsonb),
        'members', (select count(*) from public.profiles p where p.role <> 'member' and s.clinic = any (public.member_clinics(p.id))))
        order by s.pos) from public.absence_clinic_settings s), '[]'::jsonb),
    'cadres', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id), 'role', p.role) order by lower(public.member_name(p.id)))
                        from public.profiles p where p.role in ('cadre', 'direction') and p.absence_validator), '[]'::jsonb),
    'cadres_sans_validation', (select count(*) from public.profiles p where p.role = 'cadre' and not p.absence_validator));
end;
$$;

create or replace function public.can_validate_absence(p_validator uuid, p_user uuid, p_from date, p_to date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles v where v.id = p_validator and v.role = 'admin')
      or (p_validator <> p_user
          and public.tool_allowed(p_validator, 'absences')
          and exists (select 1 from public.absence_validators av
                      join public.profiles v on v.id = av.user_id and v.role in ('cadre', 'direction') and v.absence_validator
                      where av.user_id = p_validator and av.clinic = any (public.member_clinics(p_user, p_from, p_to))));
$$;

create or replace function public.absence_required_validators(p_user uuid, p_from date, p_to date) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct av.user_id), '{}'::uuid[])
  from public.absence_validators av
  join public.profiles v on v.id = av.user_id and v.role in ('cadre', 'direction') and v.absence_validator
  where av.clinic = any (public.member_clinics(p_user, p_from, p_to)) and av.user_id <> p_user and public.tool_allowed(av.user_id, 'absences');
$$;

create or replace function public.absence_validator_ids(p_user uuid, p_from date, p_to date) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(public.absence_required_validators(p_user, p_from, p_to), '{}'),
    nullif(public.absence_direction_recipients(p_user), '{}'::uuid[]),
    '{}');
$$;

create or replace function public.absence_open_round(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a public.absences;
begin
  select * into a from public.absences where id = p_id;
  if not found then return; end if;
  delete from public.absence_approvals where absence_id = p_id;
  insert into public.absence_approvals (absence_id, validator_id)
    select p_id, v from unnest(public.absence_required_validators(a.user_id, public.absence_lo(a), public.absence_hi(a))) v;
  -- 1re ligne : les validateurs des cliniques ; sans validateur, la demande attend directement la direction (2e ligne)
  update public.absences set stage = case when exists (select 1 from public.absence_approvals where absence_id = p_id) then 1 else 2 end where id = p_id;
end;
$$;

create or replace function public.absence_my_validators() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); v uuid[]; fb boolean := false;
begin
  perform public.absence_guard();
  if exists (select 1 from public.absences where user_id = uid and status = 'draft') then
    select coalesce(array_agg(distinct x), '{}') into v
      from public.absences a, unnest(public.absence_required_validators(uid, a.start_date, a.end_date)) x
      where a.user_id = uid and a.status = 'draft';
    fb := exists (select 1 from public.absences a where a.user_id = uid and a.status = 'draft'
                  and coalesce(array_length(public.absence_required_validators(uid, a.start_date, a.end_date), 1), 0) = 0);
  else
    v := public.absence_required_validators(uid);
    fb := coalesce(array_length(v, 1), 0) = 0;
  end if;
  if fb then v := v || coalesce(array(select x from unnest(public.absence_direction_recipients(uid)) x where not (x = any (v))), '{}'); end if;
  return jsonb_build_object('fallback', fb,
    'validators', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by public.member_name(x)) from unnest(v) x), '[]'::jsonb));
end;
$$;

create or replace function public.absence_resend_pairs(p_user uuid, p_ids bigint[])
returns table (absence_id bigint, recipient uuid)
language sql stable security definer set search_path = public as $$
  select p.absence_id, p.validator_id from public.absence_approvals p join public.absences a on a.id = p.absence_id
  where p.absence_id = any (p_ids) and p.decision = 'pending' and public.can_validate_absence(p.validator_id, p_user, public.absence_lo(a), public.absence_hi(a))
  union
  select i, ad from unnest(p_ids) i cross join unnest(public.absence_direction_recipients(p_user)) ad
  where not exists (select 1 from public.absence_approvals p join public.absences a on a.id = p.absence_id
                    where p.absence_id = i and p.decision = 'pending' and public.can_validate_absence(p.validator_id, p_user, public.absence_lo(a), public.absence_hi(a)));
$$;

-- 1re ligne terminée (plus aucun validateur de clinique en attente) : la demande passe en 2e ligne et la direction est prévenue.
-- C'est la direction (ou un admin) qui conclut ; absence_decide s'en charge.
create or replace function public.absence_try_complete(p_id bigint, p_by uuid, p_comment text) returns boolean
language plpgsql security definer set search_path = public as $$
declare a public.absences; pend int;
begin
  select * into a from public.absences where id = p_id for update;
  if not found or not (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null)) then return false; end if;
  if a.stage = 2 then return false; end if;
  select count(*) filter (where decision = 'pending' and public.can_validate_absence(validator_id, a.user_id, public.absence_lo(a), public.absence_hi(a)))
    into pend from public.absence_approvals where absence_id = p_id;
  if pend > 0 then return false; end if;
  update public.absences set stage = 2 where id = p_id;
  perform public.absence_enqueue_direction(array[p_id], a.user_id);
  return true;
end;
$$;

create or replace function public.absence_decide(p_id bigint, p_approve boolean, p_comment text) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences; c text := nullif(trim(coalesce(p_comment, '')), ''); r text; d text; second boolean;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  r := public.current_role_name();
  second := a.stage = 2 and r <> 'admin';
  if second then
    if not (r = 'direction' and uid <> a.user_id) then raise exception 'Cette demande attend le visa de la direction.' using errcode = '42501'; end if;
  elsif not public.can_validate_absence(uid, a.user_id, public.absence_lo(a), public.absence_hi(a)) then
    raise exception 'Vous ne validez pas les absences de ce membre.' using errcode = '42501';
  end if;
  if not (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null)) then raise exception 'Cette absence n''attend aucune décision.'; end if;
  if not coalesce(p_approve, false) and char_length(coalesce(c, '')) < 3 then raise exception 'Un refus demande un commentaire.'; end if;
  if char_length(coalesce(c, '')) > 500 then raise exception 'Commentaire trop long (500 caractères au plus).'; end if;

  if second then
    -- 2e ligne : le visa de la direction conclut la demande
    if p_approve then
      update public.absences set direction_by = uid, direction_at = now() where id = p_id;
      perform public.absence_finalize_approve(p_id, uid, c);
    else
      perform public.absence_finalize_reject(p_id, uid, c);
    end if;
  else
    select decision into d from public.absence_approvals where absence_id = p_id and validator_id = uid;
    if d in ('approved', 'rejected') and r <> 'admin' then raise exception 'Vous avez déjà donné votre décision.'; end if;
    insert into public.absence_approvals (absence_id, validator_id, decision, comment, decided_at)
      values (p_id, uid, case when p_approve then 'approved' else 'rejected' end, c, now())
      on conflict (absence_id, validator_id) do update set decision = excluded.decision, comment = excluded.comment, decided_at = excluded.decided_at;
    if not p_approve then
      perform public.absence_finalize_reject(p_id, uid, c);
    elsif r = 'admin' then
      -- l'administrateur tranche seul : toute la chaîne est soldée, son nom tient lieu de visa de la direction
      update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
      update public.absences set direction_by = uid, direction_at = now() where id = p_id;
      perform public.absence_finalize_approve(p_id, uid, c);
    else
      perform public.absence_try_complete(p_id, uid, c);
    end if;
  end if;
  return (select case when status = 'requested' or (status = 'approved' and change_type is not null) then 'requested' else status end from public.absences where id = p_id);
end;
$$;

drop function if exists public.absence_to_validate();
create or replace function public.absence_to_validate()
returns table (id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text,
  change_type text, change_kind text, change_note text, change_start date, change_end date, created_at timestamptz,
  change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb, stage int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, a.note, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, coalesce(a.submitted_at, a.created_at), a.change_requested_at,
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select p.decision from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid()), 'pending'),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(p.validator_id), 'decision', p.decision, 'comment', p.comment, 'at', p.decided_at)
                     order by public.member_name(p.validator_id)) from public.absence_approvals p where p.absence_id = a.id), '[]'::jsonb),
           a.stage::int
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.absence_actionable(auth.uid(), a)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

create or replace function public.absence_pending_count() returns integer
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null or not public.tool_allowed(auth.uid(), 'absences') then 0
    else (select count(*)::int from public.absences a
          where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
            and public.absence_actionable(auth.uid(), a)) end;
$$;

create or replace function public.absence_list(p_user uuid default null) returns setof public.absences
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid and not (public.can_validate_absence(uid, p_user) or public.is_direction_admin()) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  return query select * from public.absences a where a.user_id = coalesce(p_user, uid)
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    and (a.status <> 'draft' or a.user_id = uid)
    order by a.start_date desc;
end;
$$;

create or replace function public.absence_approvals_all(p_user uuid default null)
returns table (absence_id bigint, validator_name text, decision text, comment text, decided_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid and not (public.can_validate_absence(uid, p_user) or public.is_direction_admin()) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  return query
    select p.absence_id, public.member_name(p.validator_id), p.decision, p.comment, p.decided_at
    from public.absence_approvals p join public.absences a on a.id = p.absence_id
    where a.user_id = coalesce(p_user, uid) and (a.status in ('requested', 'rejected') or (a.status = 'approved' and a.change_type is not null))
    order by p.absence_id, public.member_name(p.validator_id);
end;
$$;

create or replace function public.absence_grid(p_from date, p_to date)
returns table (id bigint, user_id uuid, kind text, status text, start_date date, end_date date, note text, change_type text, change_start date, change_end date)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Période invalide.'; end if;
  return query
    select a.id, a.user_id, a.kind, a.status, a.start_date, a.end_date,
           case when a.user_id = auth.uid() or public.is_direction_admin() or public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)) then a.note end,
           a.change_type, a.change_start, a.change_end
    from public.absences a
    where a.status in ('requested', 'approved') and a.start_date <= p_to and a.end_date >= p_from
    order by a.start_date;
end;
$$;

create or replace function public.absence_context() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text; v text[];
begin
  perform public.absence_guard();
  select role into r from public.profiles where id = uid;
  v := case when r = 'admin' then array(select clinic from public.absence_clinic_settings order by pos)
            else array(select av.clinic from public.absence_validators av join public.absence_clinic_settings s using (clinic)
                       where av.user_id = uid and r in ('cadre', 'direction') and exists (select 1 from public.profiles q where q.id = uid and q.absence_validator)
                       order by s.pos) end;
  return jsonb_build_object('me', uid, 'role', r, 'clinics', public.member_clinics(uid), 'validates', to_jsonb(v), 'pending', public.absence_pending_count());
end;
$$;

create or replace function public.absence_form_access(p_caller uuid, p_ids bigint[]) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare owner uuid;
begin
  select user_id into owner from public.absences where id = any (p_ids) limit 1;
  if owner is null or p_caller is null then return false; end if;
  return p_caller = owner
      or public.can_validate_absence(p_caller, owner)
      or exists (select 1 from public.profiles where id = p_caller and role in ('admin', 'direction'));
end;
$$;

create or replace function public.absence_form_data(p_ids bigint[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare owner uuid; r text;
begin
  select user_id into owner from public.absences where id = any (p_ids) limit 1;
  if owner is null then return null; end if;
  if exists (select 1 from public.absences where id = any (p_ids) and (user_id <> owner or status <> 'approved')) then return null; end if;
  select role into r from public.profiles where id = owner;
  if r not in ('clinician', 'cdc', 'cadre') then return jsonb_build_object('role', r, 'no_form', true); end if;
  return jsonb_build_object(
    'owner_id', owner, 'owner', public.member_name(owner), 'role', r, 'clinics', to_jsonb(public.member_clinics(owner)),
    'requested_at', (select min(coalesce(submitted_at, created_at)) from public.absences where id = any (p_ids)),
    'absences', (select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'start_date', start_date, 'end_date', end_date, 'note', note) order by start_date, id)
                 from public.absences where id = any (p_ids)),
    'direction', (select jsonb_build_object('name', public.member_name(x.direction_by), 'at', x.direction_at) from public.absences x
                 where x.id = any (p_ids) and x.direction_by is not null order by x.direction_at desc limit 1),
    'signers', coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(s.validator_id), 'at', s.at, 'comment', s.comment) order by s.at)
                 from (select validator_id, max(decided_at) as at, nullif(string_agg(distinct nullif(trim(comment), ''), ' / '), '') as comment
                       from public.absence_approvals where absence_id = any (p_ids) and decision = 'approved' and decided_at is not null
                       group by validator_id) s), '[]'::jsonb));
end;
$$;

-- ===== 4. Absences au nom d'un membre (direction et admin), validées d'office =====
create or replace function public.absence_direction_add(p_user uuid, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); new_id bigint;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  if p_user is null or not exists (select 1 from public.profiles where id = p_user and role <> 'member') or not public.tool_allowed(p_user, 'absences') then
    raise exception 'Membre introuvable ou sans accès à Absences.';
  end if;
  if p_user = uid and public.current_role_name() <> 'admin' then raise exception 'Vous ne pouvez pas valider vos propres absences.' using errcode = '42501'; end if;
  perform public.absence_check(p_user, null, p_kind, n, p_start, p_end);
  insert into public.absences (user_id, kind, note, start_date, end_date, status, submitted_at, decision, decided_by, decided_at, direction_by, direction_at, stage)
    values (p_user, p_kind, n, p_start, p_end, 'approved', now(), 'approved', uid, now(), uid, now(), 1) returning id into new_id;
  if p_user <> uid then
    perform public.absence_enqueue('direction_change', p_user, array[new_id], jsonb_build_object('action', 'added', 'by', public.member_name(uid)));
  end if;
  perform public.absence_form_after(new_id);
  return jsonb_build_object('id', new_id, 'conflicts', public.absence_conflicts_json(p_user, p_start, p_end));
end;
$$;

-- Modifier une absence validée (dates, motif, précision) : reste validée ; une demande de changement en cours est classée
create or replace function public.absence_direction_update(p_id bigint, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.status <> 'approved' then raise exception 'Seule une absence validée se modifie ici (une demande en cours se décide dans « À valider »).'; end if;
  if a.user_id = uid and public.current_role_name() <> 'admin' then raise exception 'Vous ne pouvez pas modifier vos propres absences validées.' using errcode = '42501'; end if;
  perform public.absence_check(a.user_id, p_id, p_kind, n, p_start, p_end);
  update public.absences set kind = p_kind, note = n, start_date = p_start, end_date = p_end,
    change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null, change_requested_at = null,
    stage = 1, direction_by = uid, direction_at = now(), notified_at = null where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'edited', 'by', public.member_name(uid)));
  end if;
  return jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(a.user_id, p_start, p_end));
end;
$$;

-- Annuler une absence validée ou en cours de validation
create or replace function public.absence_direction_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id for update;
  if not found or a.status not in ('approved', 'requested') then raise exception 'Absence introuvable ou déjà décidée.'; end if;
  if a.user_id = uid and public.current_role_name() <> 'admin' then raise exception 'Vous annulez vos propres absences par la demande de suppression.' using errcode = '42501'; end if;
  update public.absences set status = 'cancelled', change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
    change_requested_at = null, stage = 1 where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'cancelled', 'by', public.member_name(uid)));
  end if;
end;
$$;

-- ===== 5. Droits d'exécution =====
do $$
declare f text;
begin
  foreach f in array array[
    'absence_direction_add(uuid, text, text, date, date)', 'absence_direction_update(bigint, text, text, date, date)', 'absence_direction_cancel(bigint)',
    'absence_decide(bigint, boolean, text)', 'absence_to_validate()', 'absence_pending_count()', 'absence_list(uuid)', 'absence_approvals_all(uuid)',
    'absence_grid(date, date)', 'absence_context()', 'absence_my_validators()', 'admin_members()', 'admin_set_role(uuid, text)', 'admin_set_tool(uuid, text, boolean)',
    'admin_reset_tools(uuid)', 'admin_set_cdc_clinics(uuid, text[])', 'admin_set_clinics(uuid, text[])', 'admin_clinic_changes()',
    'admin_clinic_change_save(uuid, date, text[])', 'admin_clinic_change_delete(uuid, date)', 'admin_set_absence_threshold(text, integer)',
    'admin_set_absence_validator(uuid, boolean)', 'admin_set_absence_validators(text, uuid[])', 'admin_absence_config()',
    'admin_calendar_confirm(bigint)', 'admin_calendar_delete(bigint)', 'admin_calendar_list()', 'admin_calendar_save(bigint, text, text, date, date)',
    'admin_calendar_sync_status()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.absence_form_access(uuid, bigint[]) from public, anon, authenticated;
grant execute on function public.absence_form_access(uuid, bigint[]) to service_role;
revoke execute on function public.absence_form_data(bigint[]) from public, anon, authenticated;
grant execute on function public.absence_form_data(bigint[]) to service_role;
