-- Rôle « infirmier·ère » (code `nurse`, 12.11.2026).
-- Accès par défaut : Durée (planification des traitements), Key trials, Formation, Annuaire prestataires, Annuaire pour médecins.
-- Durée et les deux annuaires exigent l'institution CHUV, comme pour les médecins et assistantes ; Key trials et Formation non.
-- Pas d'accès à Absences, Congrès, Lettres, Limitations LS, Lettres médicales, CTCAE (outil statique, voir app/ctcae.html).
-- Partant des définitions en production au 12.11.2026 ; seules les lignes « nurse » sont ajoutées. Réexécutable.
begin;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('member', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'direction', 'nurse', 'admin'));

create or replace function public.tool_allowed(p_user uuid, p_tool text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; i text; m boolean; o boolean;
begin
  select role, institution, med_plus into r, i, m from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if r = 'admin' then return true; end if;
  if p_tool = 'absences' and coalesce(i, '') <> 'CHUV' then return false; end if;
  if r = 'direction' then return p_tool in ('absences', 'congres', 'formation', 'annuaire', 'contacts'); end if;
  if p_tool = 'medletters' then return r in ('clinician', 'cdc', 'cadre', 'pharmacist') and coalesce(m, false); end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'absences' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'congres' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse')
    when 'formation' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse')
    when 'annuaire' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'cdc', 'cadre', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician', 'cdc', 'cadre', 'nurse') and i = 'CHUV')
    else false end;
end;
$$;
revoke execute on function public.tool_allowed(uuid, text) from public, anon, authenticated;

create or replace function public.is_hive_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() in ('admin', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse'), false);
$$;

-- Fichiers du bucket « hive » (schémas des Key trials) : lisibles par les membres validés, infirmiers compris
drop policy if exists "hive files: validated members read" on storage.objects;
create policy "hive files: validated members read" on storage.objects
  for select to authenticated
  using (bucket_id = 'hive' and public.current_role_name() in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse', 'admin'));

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
  if p_role not in ('member', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'direction', 'nurse', 'admin') then
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

insert into public.onconic_migrations(version) values ('202611120001') on conflict do nothing;
commit;
