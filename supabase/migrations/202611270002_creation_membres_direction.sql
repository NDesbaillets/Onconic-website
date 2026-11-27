-- Création de membres permanents par la direction et l'administrateur (27.11.2026). Transactionnel et réexécutable.
--
-- 1. temp_account_log.action accepte « member_create » (journal commun des créations de comptes).
-- 2. member_create_rule(rôle de l'auteur, rôle créé) : règle unique d'autorisation (interne, fermée à tous).
--    - administrateur : médecin assistant, CDC, médecin cadre, assistante, infirmier·ère, pharmacien·ne et direction ;
--    - direction : les mêmes sans « direction » ; personne ne crée un compte « admin » par cette voie.
-- 3. member_create_allowed(rôle) : appelée par l'interface et par l'Edge Function member-create (client avec le JWT de l'appelant).
--    Passe par current_role_name(), donc une fin d'accès échue retire le droit.
-- 4. member_create_apply(...) : appelée seulement par l'Edge Function (service_role), après la création du compte d'authentification.
--    Relit le rôle de l'auteur dans profiles (jamais auth.uid()), refuse d'écraser un membre déjà doté d'un rôle, pose le profil,
--    les cliniques (clinic_choice_check, comme admin_set_clinics), remet les accès par défaut du rôle (comme admin_set_role) et journalise.
-- Aucun changement pour can_manage_temps() ni pour les comptes temporaires.
begin;

-- 1. Journal --------------------------------------------------------------------------------------------------------------------
do $$
declare n text; d text;
begin
  select conname, pg_get_constraintdef(oid) into n, d from pg_constraint
   where conrelid = 'public.temp_account_log'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%lead_off%'
     and conkey = array[(select attnum from pg_attribute where attrelid = 'public.temp_account_log'::regclass and attname = 'action')]
   limit 1;
  if n is null then
    alter table public.temp_account_log add constraint temp_account_log_action_check check (action in
      ('create', 'extend', 'end', 'expire', 'set_until', 'lead_on', 'lead_off', 'member_create'));
  elsif position('member_create' in d) = 0 then
    execute format('alter table public.temp_account_log drop constraint %I', n);
    alter table public.temp_account_log add constraint temp_account_log_action_check check (action in
      ('create', 'extend', 'end', 'expire', 'set_until', 'lead_on', 'lead_off', 'member_create'));
  end if;
end $$;

-- 2. Règle unique -----------------------------------------------------------------------------------------------------------------
create or replace function public.member_create_rule(p_actor_role text, p_role text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(case
    when p_actor_role = 'admin' then p_role in ('clinician', 'cdc', 'cadre', 'assistant', 'nurse', 'pharmacist', 'direction')
    when p_actor_role = 'direction' then p_role in ('clinician', 'cdc', 'cadre', 'assistant', 'nurse', 'pharmacist')
    else false end, false);
$$;
revoke execute on function public.member_create_rule(text, text) from public, anon, authenticated;

-- 3. Droit de l'appelant ----------------------------------------------------------------------------------------------------------
create or replace function public.member_create_allowed(p_role text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.member_create_rule(public.current_role_name(), p_role);
$$;
revoke execute on function public.member_create_allowed(text) from public, anon;
grant execute on function public.member_create_allowed(text) to authenticated;

-- Validation commune des cliniques et de l'institution (une seule règle pour member_create_check et member_create_apply).
-- Codes d'erreur : OC001 institution inconnue, OC002 clinique inconnue.
create or replace function public.member_create_validate(p_role text, p_institution text, p_clinics text[], p_cdc_clinics text[])
returns table (institution text, clinics text[], cdc_clinics text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_inst text; v_clinics text[] := '{}'; v_cdc text[] := '{}';
begin
  -- Institution : CHUV (défaut) ou hors CHUV (vide), comme dans l'écran d'examen des demandes
  if p_institution is null or p_institution in ('', 'CHUV') then v_inst := 'CHUV';
  elsif p_institution = 'Hors CHUV' then v_inst := null;
  else raise exception 'Institution inconnue.' using errcode = 'OC001'; end if;
  begin
    if p_role in ('clinician', 'cdc', 'cadre') then v_clinics := public.clinic_choice_check(p_clinics); end if;
    if p_role in ('cdc', 'cadre') then
      v_cdc := public.clinic_choice_check(p_cdc_clinics);
      -- mêmes cliniques que admin_set_cdc_clinics : Plateforme n'en fait pas partie
      if 'Plateforme' = any (v_cdc) then raise exception 'Clinique inconnue : Plateforme'; end if;
    end if;
  exception when raise_exception then
    raise exception '%', sqlerrm using errcode = 'OC002';
  end;
  return query select v_inst, v_clinics, v_cdc;
end;
$$;
revoke execute on function public.member_create_validate(text, text, text[], text[]) from public, anon, authenticated;

-- Contrôle en lecture seule, appelé par l'Edge Function avec le JWT de l'appelant AVANT de créer le compte d'authentification
create or replace function public.member_create_check(p_role text, p_clinics text[], p_cdc_clinics text[], p_institution text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.member_create_allowed(p_role) then raise exception 'Création refusée pour ce rôle.' using errcode = '42501'; end if;
  perform 1 from public.member_create_validate(p_role, p_institution, p_clinics, p_cdc_clinics);
end;
$$;
revoke execute on function public.member_create_check(text, text[], text[], text) from public, anon;
grant execute on function public.member_create_check(text, text[], text[], text) to authenticated;

-- 4. Application du profil (Edge Function seulement) ------------------------------------------------------------------------------
create or replace function public.member_create_apply(p_actor uuid, p_user uuid, p_role text, p_first text, p_last text, p_institution text,
  p_clinics text[], p_cdc_clinics text[], p_mode text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor_role text; v_cur text; v_first text := left(btrim(coalesce(p_first, '')), 80); v_last text := left(btrim(coalesce(p_last, '')), 80);
  v_inst text; v_clinics text[] := '{}'; v_cdc text[] := '{}';
begin
  -- Rôle de l'auteur relu dans la base (fin d'accès échue : plus aucun droit)
  select case when p.access_until is not null and p.access_until < public.ch_date() then 'member' else p.role end
    into v_actor_role from public.profiles p where p.id = p_actor;
  if not public.member_create_rule(v_actor_role, p_role) then
    raise exception 'Création refusée pour ce rôle.' using errcode = '42501';
  end if;
  if p_actor = p_user then raise exception 'Création refusée.' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('invite', 'password') then raise exception 'Mode inconnu.'; end if;
  if v_first = '' or v_last = '' then raise exception 'Prénom et nom sont nécessaires.'; end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then raise exception 'Compte introuvable.'; end if;
  select role into v_cur from public.profiles where id = p_user for update;
  if not found then raise exception 'Profil introuvable.'; end if;
  if v_cur <> 'member' then raise exception 'Ce compte a déjà un rôle.'; end if;
  select v.institution, v.clinics, v.cdc_clinics into v_inst, v_clinics, v_cdc from public.member_create_validate(p_role, p_institution, p_clinics, p_cdc_clinics) v;

  update public.profiles set role = p_role, first_name = v_first, last_name = v_last, full_name = v_first || ' ' || v_last,
    institution = v_inst, created_by = p_actor, access_until = null, admin_lead = false,
    clinics = v_clinics, cdc_clinics = v_cdc,
    -- cliniques choisies par l'administration : initialisées ; vides : le médecin choisit lui-même à sa première connexion
    clinics_initialized = clinics_initialized or cardinality(v_clinics) > 0
    where id = p_user;
  -- Accès par défaut du rôle, comme admin_set_role
  delete from public.tool_access where user_id = p_user;
  if p_role in ('clinician', 'cdc', 'cadre') then perform public.absence_reroute(p_user); end if;
  perform public.absence_recheck();
  insert into public.temp_account_log (actor, target, action, detail)
    values (p_actor, p_user, 'member_create', jsonb_build_object('role', p_role, 'mode', p_mode));
end;
$$;
revoke execute on function public.member_create_apply(uuid, uuid, text, text, text, text, text[], text[], text) from public, anon, authenticated;
grant execute on function public.member_create_apply(uuid, uuid, text, text, text, text, text[], text[], text) to service_role;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611270002') on conflict do nothing;
  end if;
end $$;

commit;
