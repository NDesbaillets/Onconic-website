-- Cliniques : « Radiologie interventionnelle » devient « Rad-Inter » ; deux cliniques s'ajoutent, ION et UTOH.
-- À exécuter après absences.sql, formation.sql et trials_roles.sql. Sans danger si relancé.
-- Les listes de cliniques côté site (Congrès, Key trials, Formation, Administration) sont dans assets/js.

-- ===== 1. Renommage dans les données =====
-- absence_validators suit par ON UPDATE CASCADE
update public.absence_clinic_settings set clinic = 'Rad-Inter' where clinic = 'Radiologie interventionnelle';
update public.profiles set clinics = array_replace(clinics, 'Radiologie interventionnelle', 'Rad-Inter'),
  cdc_clinics = array_replace(cdc_clinics, 'Radiologie interventionnelle', 'Rad-Inter')
  where 'Radiologie interventionnelle' = any (clinics) or 'Radiologie interventionnelle' = any (cdc_clinics);
update public.events set clinics = array_replace(clinics, 'Radiologie interventionnelle', 'Rad-Inter') where 'Radiologie interventionnelle' = any (clinics);
update public.key_trials set clinic = 'Rad-Inter' where clinic = 'Radiologie interventionnelle';
update public.letters set clinic = 'Rad-Inter' where clinic = 'Radiologie interventionnelle';
update public.medletter_templates set clinic = 'Rad-Inter' where clinic = 'Radiologie interventionnelle';
update public.protocols set clinic = 'Rad-Inter' where clinic = 'Radiologie interventionnelle';

-- Formation : la contrainte liste les cliniques autorisées
alter table public.trainings drop constraint if exists trainings_clinic_check;
update public.trainings set clinic = 'Rad-Inter' where clinic = 'Radiologie interventionnelle';
alter table public.trainings add constraint trainings_clinic_check
  check (clinic in ('Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome',
                    'Lower GI', 'Upper GI', 'ORL', 'Sarcomes', 'Rad-Inter', 'ION', 'UTOH'));

-- ===== 2. Absences : ION et UTOH avant Plateforme et Administration =====
update public.absence_clinic_settings set pos = case clinic when 'Plateforme' then 14 when 'Administration' then 15 end
  where clinic in ('Plateforme', 'Administration');
insert into public.absence_clinic_settings (clinic, pos) values ('ION', 12), ('UTOH', 13) on conflict (clinic) do nothing;

-- ===== 3. Key trials : cliniques gérables par un CDC =====
create or replace function public.admin_set_cdc_clinics(p_user uuid, p_clinics text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare r text; bad text;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is distinct from 'cdc' then raise exception 'Réservé aux membres du rôle CDC.'; end if;
  select c into bad from unnest(coalesce(p_clinics, '{}')) c
    where c not in ('Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome',
                    'Lower GI', 'Upper GI', 'ORL', 'Sarcomes', 'Rad-Inter', 'ION', 'UTOH') limit 1;
  if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
  update public.profiles set cdc_clinics = coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}')) c order by c), '{}')
    where id = p_user;
  return (select cdc_clinics from public.profiles where id = p_user);
end;
$$;
