-- Lecture des fériés ajoutés à la main (27.11.2026). Transactionnel et réexécutable.
--
-- calendar_feries(p_from, p_to) : un enregistrement (jour, intitulé) par jour couvert par une entrée « ferie » de absence_calendar dans la plage
-- (plages dépliées). Lue par le planning administratif et Oncoodle, pour griser ces jours et sauter ces dates à la génération de créneaux.
-- Tout compte connecté qui a un rôle (autre que « member ») peut l'appeler, sans exiger l'outil Absences. Ne renvoie jamais les autres types
-- d'entrées (événements, présences obligatoires, vacances scolaires), ni auteurs, ni identifiants. Plage bornée à 800 jours.
-- Les fériés vaudois calculés ne sont pas renvoyés : les pages les calculent elles-mêmes (assets/js/vd-holidays.js).
begin;

create or replace function public.calendar_feries(p_from date, p_to date) returns table (day date, label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r text;
begin
  if auth.uid() is null then raise exception 'Connexion requise.' using errcode = '42501'; end if;
  r := public.current_role_name();
  if r is null or r = 'member' then raise exception 'Accès réservé aux membres.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Vérifiez les dates.'; end if;
  if p_to - p_from > 800 then raise exception 'Plage trop longue (800 jours au plus).'; end if;
  return query
    select g.d::date, c.label
      from public.absence_calendar c
      cross join lateral generate_series(greatest(c.start_date, p_from), least(c.end_date, p_to), interval '1 day') g (d)
     where c.kind = 'ferie' and c.start_date <= p_to and c.end_date >= p_from
     order by 1, 2;
end;
$$;
revoke execute on function public.calendar_feries(date, date) from public, anon;
grant execute on function public.calendar_feries(date, date) to authenticated;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611270004') on conflict do nothing;
  end if;
end $$;

commit;
