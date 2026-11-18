-- Cliniques « Lower GI » et « Upper GI » remplacées par « GI tube » et « GI solide » (18.11.2026).
--   GI tube  : œsophage, estomac et jonction œsogastrique, colorectal, canal anal, GIST, tumeurs neuroendocrines digestives non pancréatiques.
--   GI solide : pancréas (y compris TNE pancréatiques), voies biliaires, carcinome hépatocellulaire.
-- Règles de conversion :
--   tableaux de cliniques : Lower GI -> GI tube ; Upper GI -> GI tube + GI solide ; doublons retirés, ordre conservé ;
--   lignes rattachées à une clinique par une clé (validateurs, attributions de circuit...) : mêmes règles, par copie puis suppression ;
--   colonne texte à une seule clinique : Lower GI -> GI tube ; Upper GI -> GI solide si la colonne diagnostic ou pathologie
--   évoque pancréas, voies biliaires ou foie, GI tube sinon, et GI solide si la table n'a aucune colonne diagnostic ;
--   réglages d'absences : Lower GI devient GI tube et Upper GI devient GI solide (même position, même seuil).
-- Les colonnes sont repérées dans le catalogue (colonnes `clinic` texte, colonnes texte[] dont le nom finit par `clinics`), ce qui
-- couvre aussi les tables des migrations 202611180001 et 202611180002 si elles sont présentes. Aucune dépendance envers elles.
-- Les journaux d'audit et les documents d'absence figés ne sont pas réécrits (état historique).
-- Les déclencheurs utilisateur des seules tables modifiées sont suspendus pendant la conversion (historique des cliniques,
-- horodatage, journal des événements), puis réactivés dans la même transaction.
-- Réexécutable : une seconde exécution ne trouve plus d'ancien nom.
begin;

create table if not exists public.onconic_migrations(version text primary key, applied_at timestamptz not null default now());
revoke all on public.onconic_migrations from anon, authenticated;

create or replace function pg_temp.gi_arr(a text[]) returns text[] language plpgsql immutable as $$
declare res text[] := '{}'; e text; x text;
begin
  if a is null then return null; end if;
  foreach e in array a loop
    foreach x in array (case e when 'Lower GI' then array['GI tube'] when 'Upper GI' then array['GI tube', 'GI solide'] else array[e] end) loop
      if x is null or not (x = any (res)) then res := res || x; end if;
    end loop;
  end loop;
  return res;
end;
$$;

create or replace function pg_temp.gi_one(c text, diag text, has_diag boolean) returns text language sql immutable as $$
  select case c
    when 'Lower GI' then 'GI tube'
    when 'Upper GI' then case
      when not has_diag then 'GI solide'
      when translate(lower(coalesce(diag, '')), 'éèêëàâîïôùûç', 'eeeeaaiiouuc') ~ 'pancr|biliaire|cholangio|vesicule|hepat|\mchc\M|foie' then 'GI solide'
      else 'GI tube' end
    else c end;
$$;

do $mig$
declare
  r record; chk jsonb := '[]'::jsonb; k jsonb; n bigint;
  cols text; sel_tube text; sel_solide text; dcol text; keyed boolean;
begin
  -- 1. Contraintes check qui listent les cliniques (ex. trainings_clinic_check) : retirées, puis recréées avec la nouvelle liste
  for r in
    select c.conrelid::regclass::text as tbl, c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace s on s.oid = t.relnamespace
    where c.contype = 'c' and s.nspname = 'public'
      and (pg_get_constraintdef(c.oid) like '%Lower GI%' or pg_get_constraintdef(c.oid) like '%Upper GI%')
  loop
    chk := chk || jsonb_build_array(jsonb_build_object('tbl', r.tbl, 'name', r.conname,
      'def', replace(replace(r.def, '''Lower GI''', '''GI tube'''), '''Upper GI''', '''GI solide''')));
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;

  -- 2. Réglages d'absences : nouvelles lignes créées d'abord (les clés étrangères pointent dessus), anciennes supprimées à la fin
  if to_regclass('public.absence_clinic_settings') is not null then
    insert into public.absence_clinic_settings (clinic, pos, max_absent)
      select 'GI tube', s.pos, s.max_absent from public.absence_clinic_settings s where s.clinic = 'Lower GI'
      on conflict (clinic) do nothing;
    insert into public.absence_clinic_settings (clinic, pos, max_absent)
      select 'GI solide', s.pos, s.max_absent from public.absence_clinic_settings s where s.clinic = 'Upper GI'
      on conflict (clinic) do nothing;
  end if;

  -- 3. Colonnes texte `clinic` (hors réglages d'absences)
  for r in
    select c.relname as t, a.attname as col
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      and a.attname = 'clinic' and a.atttypid = 'text'::regtype and c.relname <> 'absence_clinic_settings'
    order by c.relname
  loop
    execute format('select count(*) from public.%I where %I in (''Lower GI'', ''Upper GI'')', r.t, r.col) into n;
    continue when n = 0;
    -- clé : la colonne fait partie d'un index unique (validateurs par clinique, attributions de circuit...)
    select exists (
      select 1 from pg_index i
      where i.indrelid = format('public.%I', r.t)::regclass and i.indisunique and i.indpred is null
        and (select a.attnum from pg_attribute a where a.attrelid = i.indrelid and a.attname = r.col)
            = any (string_to_array(i.indkey::text, ' ')::int2[])
    ) into keyed;
    execute format('alter table public.%I disable trigger user', r.t);
    if keyed then
      select string_agg(format('%I', a.attname), ', ' order by a.attnum),
             string_agg(case when a.attname = r.col then '''GI tube''' else format('%I', a.attname) end, ', ' order by a.attnum),
             string_agg(case when a.attname = r.col then '''GI solide''' else format('%I', a.attname) end, ', ' order by a.attnum)
        into cols, sel_tube, sel_solide
        from pg_attribute a
        where a.attrelid = format('public.%I', r.t)::regclass and a.attnum > 0 and not a.attisdropped
          and a.attidentity = '' and a.attgenerated = '';
      execute format('insert into public.%1$I (%2$s) select %3$s from public.%1$I where %4$I in (''Lower GI'', ''Upper GI'') on conflict do nothing',
                     r.t, cols, sel_tube, r.col);
      execute format('insert into public.%1$I (%2$s) select %3$s from public.%1$I where %4$I = ''Upper GI'' on conflict do nothing',
                     r.t, cols, sel_solide, r.col);
      execute format('delete from public.%I where %I in (''Lower GI'', ''Upper GI'')', r.t, r.col);
    else
      select a.attname into dcol
        from pg_attribute a
        where a.attrelid = format('public.%I', r.t)::regclass and a.attnum > 0 and not a.attisdropped
          and a.attname in ('diagnosis', 'pathology') and a.atttypid = 'text'::regtype
        order by (a.attname = 'diagnosis') desc limit 1;
      execute format('update public.%1$I set %2$I = pg_temp.gi_one(%2$I, %3$s, %4$L::boolean) where %2$I in (''Lower GI'', ''Upper GI'')',
                     r.t, r.col, case when dcol is null then 'null::text' else format('%I', dcol) end, dcol is not null);
    end if;
    execute format('alter table public.%I enable trigger user', r.t);
  end loop;

  -- 4. Colonnes texte[] de cliniques : profiles.clinics, cdc_clinics, agenda_clinics, events.clinics, clinic_requests.clinics et
  --    previous_clinics, member_clinic_history.clinics, member_clinic_changes.clinics, absence_blocs si présent...
  for r in
    select c.relname as t, a.attname as col
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      and a.attname like '%clinics' and a.atttypid = 'text[]'::regtype
    order by c.relname, a.attname
  loop
    execute format('select count(*) from public.%I where %I && array[''Lower GI'', ''Upper GI'']', r.t, r.col) into n;
    continue when n = 0;
    execute format('alter table public.%I disable trigger user', r.t);
    execute format('update public.%1$I set %2$I = pg_temp.gi_arr(%2$I) where %2$I && array[''Lower GI'', ''Upper GI'']', r.t, r.col);
    execute format('alter table public.%I enable trigger user', r.t);
  end loop;

  -- 5. Destinataires des sondages Oncoodle : audience jsonb { rules: [{ clinics: [...], roles: [...] }] }
  if to_regclass('public.oncoodle_polls') is not null
     and exists (select 1 from public.oncoodle_polls p where p.audience::text like '%Lower GI%' or p.audience::text like '%Upper GI%') then
    alter table public.oncoodle_polls disable trigger user;
    update public.oncoodle_polls p
       set audience = jsonb_set(p.audience, '{rules}', coalesce((
         select jsonb_agg(case when jsonb_typeof(x.r -> 'clinics') = 'array'
                               then jsonb_set(x.r, '{clinics}', to_jsonb(pg_temp.gi_arr(array(select jsonb_array_elements_text(x.r -> 'clinics')))))
                               else x.r end order by x.ord)
         from jsonb_array_elements(p.audience -> 'rules') with ordinality as x(r, ord)), '[]'::jsonb))
     where jsonb_typeof(p.audience -> 'rules') = 'array'
       and (p.audience::text like '%Lower GI%' or p.audience::text like '%Upper GI%');
    alter table public.oncoodle_polls enable trigger user;
  end if;

  -- 6. Anciennes lignes de réglages (leurs validateurs ont été copiés à l'étape 3)
  if to_regclass('public.absence_clinic_settings') is not null then
    delete from public.absence_clinic_settings where clinic in ('Lower GI', 'Upper GI');
  end if;

  -- 7. Contraintes check recréées avec la nouvelle liste
  for k in select value from jsonb_array_elements(chk) loop
    execute format('alter table %s add constraint %I %s', k ->> 'tbl', k ->> 'name', k ->> 'def');
  end loop;
end;
$mig$;

-- 8. Fonction qui liste les cliniques en dur (définition d'admin_direction.sql, seule la liste change).
--    Les autres contrôles (admin_set_clinics, my_set_clinics, validateurs, Oncoodle) lisent absence_clinic_settings.
create or replace function public.admin_set_cdc_clinics(p_user uuid, p_clinics text[])
returns text[] language plpgsql security definer set search_path = public, pg_temp as $$
declare r text; bad text;
begin
  if not public.is_direction_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is null or r not in ('cdc', 'cadre') then raise exception 'Réservé aux membres du rôle CDC ou Cadre.'; end if;
  select c into bad from unnest(coalesce(p_clinics, '{}')) c
    where c not in ('Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome',
                    'GI tube', 'GI solide', 'ORL', 'Sarcomes', 'Rad-Inter', 'ION', 'UTOH') limit 1;
  if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
  update public.profiles set cdc_clinics = coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}')) c order by c), '{}')
    where id = p_user;
  return (select cdc_clinics from public.profiles where id = p_user);
end;
$$;
revoke execute on function public.admin_set_cdc_clinics(uuid, text[]) from public, anon;
grant execute on function public.admin_set_cdc_clinics(uuid, text[]) to authenticated;

insert into public.onconic_migrations(version) values ('202611180003') on conflict do nothing;

commit;
