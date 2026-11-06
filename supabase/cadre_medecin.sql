-- Rôle « cadre » = médecin cadre : exactement les droits d'un CDC (chef de clinique), plus la validation des absences
-- des cliniques pour lesquelles l'admin le désigne. Il est donc rattaché à des cliniques comme un médecin (plus à Administration)
-- et gère les fiches Key trials de ses cliniques (profiles.cdc_clinics).
-- À exécuter après absences.sql, trials_roles.sql et clinics.sql. Sans danger si relancé.

-- ===== Accès aux outils : partout où cdc figure, cadre figure =====
create or replace function public.tool_allowed(p_user uuid, p_tool text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; i text; m boolean; o boolean;
begin
  select role, institution, med_plus into r, i, m from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if r = 'admin' then return true; end if;
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

create or replace function public.is_hive_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() in ('admin', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist'), false);
$$;

drop policy if exists "hive files: validated members read" on storage.objects;
create policy "hive files: validated members read" on storage.objects
  for select to authenticated
  using (bucket_id = 'hive' and public.current_role_name() in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'admin'));

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
    from public.profiles p where p.role in ('clinician', 'cdc', 'cadre', 'pharmacist') order by 2;
end;
$$;

create or replace function public.medletters_set_access(p_user uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  update public.profiles set med_plus = p_on where id = p_user and role in ('clinician', 'cdc', 'cadre', 'pharmacist');
end;
$$;

-- ===== Key trials : le cadre gère les fiches de ses cliniques comme un CDC =====
create or replace function public.can_edit_trials(p_clinic text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'admin' or (p.role in ('cdc', 'cadre') and p_clinic is not null and p_clinic = any (p.cdc_clinics))
                   from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.admin_set_cdc_clinics(p_user uuid, p_clinics text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare r text; bad text;
begin
  if public.current_role_name() is distinct from 'admin' then
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

-- ===== Absences : le cadre est rattaché à des cliniques comme un médecin =====
create or replace function public.member_clinics(p_user uuid) returns text[] language sql stable security definer set search_path = public as $$
  select coalesce((select case when p.role in ('clinician', 'cdc', 'cadre') then p.clinics
                               when p.role in ('assistant', 'pharmacist', 'admin') then array['Administration']
                               else '{}'::text[] end
                   from public.profiles p where p.id = p_user), '{}'::text[]);
$$;

create or replace function public.admin_set_clinics(p_user uuid, p_clinics text[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare r text; bad text;
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r not in ('clinician', 'cdc', 'cadre') then raise exception 'Seuls les médecins sont rattachés à une clinique.'; end if;
  select c into bad from unnest(coalesce(p_clinics, '{}')) c
    where not exists (select 1 from public.absence_clinic_settings s where s.clinic = c and s.clinic <> 'Administration') limit 1;
  if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
  update public.profiles set clinics = coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}')) c order by c), '{}') where id = p_user;
  return (select clinics from public.profiles where id = p_user);
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
    clinics = case when p_role in ('clinician', 'cdc', 'cadre') then clinics else '{}' end
    where id = p_user;
  if not found then raise exception 'Membre introuvable.'; end if;
  if p_role <> 'cadre' then delete from public.absence_validators where user_id = p_user; end if;
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
