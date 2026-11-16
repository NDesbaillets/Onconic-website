-- Planning administratif, V1 (16.11.2026). Transactionnel et réexécutable. Suppose la migration 202611160002 (cadres administratifs).
--
-- Effectif (plan_staff) : une ligne par collaborateur·rice, reliée ou non à un compte Onconic (user_id).
-- Catalogue (plan_codes) : codes, libellés, couleurs ; « privé » = motif d'absence sensible (maladie, congé…).
-- Grille (plan_cells) : un code par personne, jour et demi-journée (0 = matin, 1 = après-midi).
-- Réglages (plan_settings) : lignes de couverture et minimums.
-- Droits : édition par les cadres administratifs, l'admin et la direction (can_edit_planning) ;
--          lecture par les membres CHUV ayant l'outil « planning » ; les motifs privés sont masqués (« ABS »)
--          sauf pour les éditeurs et la personne concernée. Les tables ne sont jamais lues ni écrites directement.
begin;

create table if not exists public.plan_codes (
  code text primary key check (code ~ '^[A-Z0-9][A-Z0-9-]{0,7}$'),
  label text not null default '' check (char_length(label) <= 120),
  grp text not null default 'Autres' check (char_length(grp) <= 60),
  bg text not null default '#FFFFFF' check (bg ~ '^#[0-9A-F]{6}$'),
  fg text not null default '#000000' check (fg ~ '^#[0-9A-F]{6}$'),
  kind text not null default 'poste' check (kind in ('poste', 'absence')),
  private boolean not null default false,
  position integer not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create table if not exists public.plan_staff (
  id bigint generated always as identity primary key,
  first_name text not null check (char_length(first_name) between 1 and 80),
  last_name text not null check (char_length(last_name) between 1 and 80),
  team text not null default 'AUTRE' check (team in ('AM', 'SEC', 'DESK', 'ENCAD', 'AUTRE')),
  bloc smallint check (bloc between 0 and 3),
  pct smallint not null default 100 check (pct between 5 and 100),
  resp text not null default '' check (char_length(resp) <= 80),
  status text not null default 'fixe' check (status in ('fixe', 'temporaire')),
  start_date date,
  end_date date,
  off_slots smallint[] not null default '{}' check (off_slots <@ array[0,1,2,3,4,5,6,7,8,9]::smallint[]),
  week text[] not null default array['','','','','','','','','',''] check (cardinality(week) = 10),
  user_id uuid unique references auth.users (id) on delete set null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  check (end_date is null or start_date is null or end_date >= start_date),
  check (status = 'fixe' or (start_date is not null and end_date is not null))
);

create table if not exists public.plan_cells (
  staff_id bigint not null references public.plan_staff (id) on delete cascade,
  day date not null,
  half smallint not null check (half in (0, 1)),
  code text not null references public.plan_codes (code) on update cascade,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  primary key (staff_id, day, half)
);
create index if not exists plan_cells_day on public.plan_cells (day);
create index if not exists plan_cells_code on public.plan_cells (code);

create table if not exists public.plan_settings (
  id smallint primary key default 1 check (id = 1),
  coverage jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.plan_codes enable row level security;
alter table public.plan_staff enable row level security;
alter table public.plan_cells enable row level security;
alter table public.plan_settings enable row level security;
revoke all on public.plan_codes, public.plan_staff, public.plan_cells, public.plan_settings from anon, authenticated;

-- Catalogue de départ (légende du tableur des cadres administratifs) ; les cadres le complètent dans l'outil
insert into public.plan_codes (code, label, grp, bg, fg, kind, private, position) values
  ('AM1', 'Assistante médecins, bloc 1', 'Assistante médecins', '#FF99FF', '#000000', 'poste', false, 10),
  ('AM2', 'Assistante médecins, bloc 2', 'Assistante médecins', '#21C5FF', '#000000', 'poste', false, 11),
  ('AM3', 'Assistante médecins, bloc 3', 'Assistante médecins', '#FFC000', '#000000', 'poste', false, 12),
  ('SEC1', 'Secrétariat, bloc 1', 'Secrétariat', '#FF99FF', '#000000', 'poste', false, 20),
  ('SEC2', 'Secrétariat, bloc 2', 'Secrétariat', '#21C5FF', '#000000', 'poste', false, 21),
  ('SEC3', 'Secrétariat, bloc 3', 'Secrétariat', '#FFC000', '#000000', 'poste', false, 22),
  ('SEC0', 'Secrétariat, attribué selon les besoins', 'Secrétariat', '#FFFFFF', '#000000', 'poste', false, 23),
  ('SA1', 'Soutien administratif, bloc 1', 'Soutien administratif', '#FF99FF', '#000000', 'poste', false, 30),
  ('SA2', 'Soutien administratif, bloc 2', 'Soutien administratif', '#21C5FF', '#000000', 'poste', false, 31),
  ('SA3', 'Soutien administratif, bloc 3', 'Soutien administratif', '#FFC000', '#000000', 'poste', false, 32),
  ('SA0', 'Soutien administratif, attribué selon les besoins', 'Soutien administratif', '#FFFFFF', '#000000', 'poste', false, 33),
  ('TT1', 'Télétravail, bloc 1', 'Télétravail', '#FF99FF', '#000000', 'poste', false, 40),
  ('TT2', 'Télétravail, bloc 2', 'Télétravail', '#21C5FF', '#000000', 'poste', false, 41),
  ('TT3', 'Télétravail, bloc 3', 'Télétravail', '#FFC000', '#000000', 'poste', false, 42),
  ('INT', 'Intégratrice', 'Télétravail', '#E2EFDA', '#000000', 'poste', false, 43),
  ('DA1', 'Desk accueil 7h30-16h30', 'Desk et accueil', '#FFFF00', '#000000', 'poste', false, 50),
  ('DA2', 'Desk accueil 8h00-17h00', 'Desk et accueil', '#FFFF00', '#000000', 'poste', false, 51),
  ('UTI', 'Accueil UTI', 'Desk et accueil', '#92D050', '#000000', 'poste', false, 52),
  ('BO1', 'Back office 7h30-16h30, référent BO et desk', 'Back office', '#002060', '#FFFFFF', 'poste', false, 60),
  ('BO2', 'Back office 8h00-17h00', 'Back office', '#0066FF', '#FFFFFF', 'poste', false, 61),
  ('BO3', 'Back office 8h00-17h00', 'Back office', '#0066FF', '#FFFFFF', 'poste', false, 62),
  ('BO4', 'Back office 7h30-16h30', 'Back office', '#0066FF', '#FFFFFF', 'poste', false, 63),
  ('BOD', 'Préparation de dossiers, archivage', 'Back office', '#0066FF', '#FFFFFF', 'poste', false, 64),
  ('CU', 'Cheffe d''unité', 'Encadrement', '#CC99FF', '#000000', 'poste', false, 70),
  ('AD', 'Administration', 'Encadrement', '#CC0099', '#FFFFFF', 'poste', false, 71),
  ('TTC', 'Télétravail (encadrement)', 'Encadrement', '#CC0099', '#FFFFFF', 'poste', false, 72),
  ('V', 'Vacances', 'Absences', '#FF0000', '#FFFFFF', 'absence', false, 80),
  ('ML', 'Maladie ou accident', 'Absences', '#FF7C80', '#000000', 'absence', true, 81),
  ('CA', 'Congé autre type', 'Absences', '#C00000', '#FFFFFF', 'absence', true, 82),
  ('FOR', 'Formation', 'Absences', '#CCFF99', '#000000', 'absence', false, 83),
  ('MIL', 'Service militaire', 'Absences', '#BFBFBF', '#000000', 'absence', true, 84)
on conflict (code) do nothing;

insert into public.plan_settings (id, coverage) values (1, '[
  {"label": "AM bloc 1", "codes": ["AM1"], "min": 2},
  {"label": "AM bloc 2", "codes": ["AM2"], "min": 2},
  {"label": "AM bloc 3", "codes": ["AM3"], "min": 2},
  {"label": "Secrétariat", "codes": ["SEC1", "SEC2", "SEC3", "SEC0"], "min": 4},
  {"label": "Desk accueil", "codes": ["DA1", "DA2"], "min": 2},
  {"label": "Back office", "codes": ["BO1", "BO2", "BO3", "BO4", "BOD"], "min": 3}
]'::jsonb) on conflict (id) do nothing;

-- ----- Droits -----
create or replace function public.can_edit_planning() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.is_admin_lead() or coalesce(public.current_role_name() in ('admin', 'direction'), false);
$$;

-- Outil « planning » : lecture pour tous les membres CHUV validés (exceptions possibles par tool_access)
create or replace function public.tool_allowed(p_user uuid, p_tool text)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare r text; i text; m boolean; o boolean; u date; l boolean;
begin
  select role, institution, med_plus, access_until, admin_lead into r, i, m, u, l from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if u is not null and u < public.ch_date() then return false; end if;
  if r = 'admin' then return true; end if;
  if p_tool = 'temporaires' then return r = 'direction' or (r = 'assistant' and coalesce(l, false)); end if;
  if p_tool in ('absences', 'planning') and coalesce(i, '') <> 'CHUV' then return false; end if;
  if r = 'direction' then return p_tool in ('absences', 'congres', 'formation', 'annuaire', 'contacts', 'oncoodle', 'planning'); end if;
  if p_tool = 'medletters' then return r in ('clinician', 'cdc', 'cadre', 'pharmacist') and coalesce(m, false); end if;
  if p_tool = 'planning' and r = 'assistant' and coalesce(l, false) then return true; end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'absences' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'congres' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'cadre', 'pharmacist', 'nurse')
    when 'formation' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse')
    when 'annuaire' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'cdc', 'cadre', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician', 'cdc', 'cadre', 'nurse') and i = 'CHUV')
    when 'planning' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse')
    when 'oncoodle' then true
    else false end;
end;
$function$;

create or replace function public.my_tools() returns text[]
language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(t), '{}') from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters', 'annuaire', 'contacts', 'formation', 'absences', 'oncoodle', 'temporaires', 'planning']) t
  where public.tool_allowed(auth.uid(), t);
$$;

-- ----- Lecture -----
-- Tout le nécessaire pour afficher une fenêtre : catalogue, couverture, effectif présent sur la fenêtre, cellules.
create or replace function public.plan_grid(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v_edit boolean; v_me uuid := auth.uid();
begin
  if not public.tool_allowed(auth.uid(), 'planning') then raise exception 'Réservé aux membres ayant l''outil Planning.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 400 then raise exception 'Fenêtre trop longue (400 jours au plus).'; end if;
  v_edit := public.can_edit_planning();
  return jsonb_build_object(
    'editor', v_edit,
    'codes', coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'label', c.label, 'grp', c.grp, 'bg', c.bg, 'fg', c.fg,
        'kind', c.kind, 'private', c.private, 'position', c.position, 'active', c.active) order by c.position, c.code) from public.plan_codes c), '[]'::jsonb),
    'coverage', (select s.coverage from public.plan_settings s where s.id = 1),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'first_name', s.first_name, 'last_name', s.last_name, 'team', s.team,
        'bloc', s.bloc, 'pct', s.pct, 'resp', s.resp, 'status', s.status, 'start_date', s.start_date, 'end_date', s.end_date,
        'off', s.off_slots, 'week', case when v_edit then to_jsonb(s.week) end, 'me', s.user_id = v_me,
        'user_id', case when v_edit then s.user_id end, 'account', case when v_edit then public.member_name(s.user_id) end)
        order by s.position, lower(s.last_name), lower(s.first_name))
      from public.plan_staff s
      where (s.start_date is null or s.start_date <= p_to) and (s.end_date is null or s.end_date >= p_from)), '[]'::jsonb),
    'cells', coalesce((select jsonb_agg(jsonb_build_array(x.staff_id, x.day, x.half,
        case when c.private and not v_edit and s.user_id is distinct from v_me then 'ABS' else x.code end))
      from public.plan_cells x join public.plan_codes c on c.code = x.code join public.plan_staff s on s.id = x.staff_id
      where x.day between p_from and p_to), '[]'::jsonb)
  );
end;
$$;

-- ----- Écriture (éditeurs seulement) -----
-- Changements de cellules par lot : [{"s": id, "d": "AAAA-MM-JJ", "h": 0|1, "c": "CODE" ou ""}] ; "" efface.
create or replace function public.plan_set_cells(p_changes jsonb) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; x jsonb; v_s bigint; v_d date; v_h smallint; v_c text; v_staff public.plan_staff;
begin
  if not public.can_edit_planning() then raise exception 'Réservé aux cadres administratifs.' using errcode = '42501'; end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'Format invalide.'; end if;
  if jsonb_array_length(p_changes) > 20000 then raise exception 'Trop de changements en une fois (20 000 au plus).'; end if;
  for x in select * from jsonb_array_elements(p_changes) loop
    v_s := (x->>'s')::bigint; v_d := (x->>'d')::date; v_h := (x->>'h')::smallint; v_c := coalesce(x->>'c', '');
    if v_h not in (0, 1) then raise exception 'Demi-journée invalide.'; end if;
    if extract(isodow from v_d) > 5 then raise exception 'Le planning ne couvre que les jours ouvrables (%).', v_d; end if;
    select * into v_staff from public.plan_staff where id = v_s;
    if v_staff.id is null then raise exception 'Collaborateur·rice introuvable (%).', v_s; end if;
    if (v_staff.start_date is not null and v_d < v_staff.start_date) or (v_staff.end_date is not null and v_d > v_staff.end_date) then
      raise exception '% : date hors de la période de présence (%).', v_staff.first_name || ' ' || v_staff.last_name, v_d;
    end if;
    if v_c = '' then
      delete from public.plan_cells where staff_id = v_s and day = v_d and half = v_h;
    else
      if not exists (select 1 from public.plan_codes where code = v_c) then raise exception 'Code inconnu : %', v_c; end if;
      insert into public.plan_cells (staff_id, day, half, code, updated_at, updated_by) values (v_s, v_d, v_h, v_c, now(), auth.uid())
      on conflict (staff_id, day, half) do update set code = excluded.code, updated_at = now(), updated_by = auth.uid()
        where plan_cells.code is distinct from excluded.code;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Fiche d'un·e collaborateur·rice (création si id absent) ; renvoie l'identifiant
create or replace function public.plan_staff_save(p jsonb) returns bigint
language plpgsql security definer set search_path to 'public' as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_user uuid := nullif(p->>'user_id', '')::uuid; v_off smallint[]; v_week text[];
begin
  if not public.can_edit_planning() then raise exception 'Réservé aux cadres administratifs.' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct (e)::smallint), '{}') into v_off from jsonb_array_elements_text(coalesce(p->'off', '[]'::jsonb)) e;
  if p ? 'week' then
    select array_agg(coalesce(e, '') order by n) into v_week from jsonb_array_elements_text(p->'week') with ordinality t(e, n);
    if cardinality(v_week) <> 10 then raise exception 'Semaine type : 10 demi-journées attendues.'; end if;
    if exists (select 1 from unnest(v_week) w where w <> '' and not exists (select 1 from public.plan_codes c where c.code = w)) then
      raise exception 'Semaine type : code inconnu.';
    end if;
  end if;
  if v_user is not null and not exists (select 1 from public.profiles where id = v_user and role <> 'member') then
    raise exception 'Compte Onconic introuvable.';
  end if;
  if v_id is null then
    insert into public.plan_staff (first_name, last_name, team, bloc, pct, resp, status, start_date, end_date, off_slots, week, user_id, position, updated_by)
    values (trim(p->>'first_name'), trim(p->>'last_name'), coalesce(nullif(p->>'team', ''), 'AUTRE'), nullif(p->>'bloc', '')::smallint,
      coalesce(nullif(p->>'pct', '')::smallint, 100), coalesce(trim(p->>'resp'), ''), coalesce(nullif(p->>'status', ''), 'fixe'),
      nullif(p->>'start_date', '')::date, nullif(p->>'end_date', '')::date, v_off, coalesce(v_week, array['','','','','','','','','','']),
      v_user, coalesce(nullif(p->>'position', '')::integer, 0), auth.uid())
    returning id into v_id;
  else
    update public.plan_staff set first_name = trim(p->>'first_name'), last_name = trim(p->>'last_name'),
      team = coalesce(nullif(p->>'team', ''), 'AUTRE'), bloc = nullif(p->>'bloc', '')::smallint, pct = coalesce(nullif(p->>'pct', '')::smallint, 100),
      resp = coalesce(trim(p->>'resp'), ''), status = coalesce(nullif(p->>'status', ''), 'fixe'),
      start_date = nullif(p->>'start_date', '')::date, end_date = nullif(p->>'end_date', '')::date, off_slots = v_off,
      week = coalesce(v_week, week), user_id = v_user,
      position = coalesce(nullif(p->>'position', '')::integer, position), updated_at = now(), updated_by = auth.uid()
    where id = v_id;
    if not found then raise exception 'Collaborateur·rice introuvable.'; end if;
  end if;
  return v_id;
end;
$$;

-- Code du catalogue (création ou modification ; jamais de suppression : « inactif » le retire de la palette)
create or replace function public.plan_code_save(p jsonb) returns text
language plpgsql security definer set search_path to 'public' as $$
declare v_code text := upper(trim(p->>'code'));
begin
  if not public.can_edit_planning() then raise exception 'Réservé aux cadres administratifs.' using errcode = '42501'; end if;
  insert into public.plan_codes (code, label, grp, bg, fg, kind, private, position, active, updated_at, updated_by)
  values (v_code, coalesce(trim(p->>'label'), ''), coalesce(nullif(trim(p->>'grp'), ''), 'Autres'), upper(coalesce(p->>'bg', '#FFFFFF')),
    upper(coalesce(p->>'fg', '#000000')), coalesce(nullif(p->>'kind', ''), 'poste'), coalesce((p->>'private')::boolean, false),
    coalesce(nullif(p->>'position', '')::integer, 900), coalesce((p->>'active')::boolean, true), now(), auth.uid())
  on conflict (code) do update set label = excluded.label, grp = excluded.grp, bg = excluded.bg, fg = excluded.fg, kind = excluded.kind,
    private = excluded.private, position = excluded.position, active = excluded.active, updated_at = now(), updated_by = auth.uid();
  return v_code;
end;
$$;

-- Lignes de couverture : [{"label": "...", "codes": ["AM1"], "min": 2}, …]
create or replace function public.plan_coverage_save(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare x jsonb;
begin
  if not public.can_edit_planning() then raise exception 'Réservé aux cadres administratifs.' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 30 then raise exception 'Format invalide.'; end if;
  for x in select * from jsonb_array_elements(p_rows) loop
    if char_length(coalesce(x->>'label', '')) not between 1 and 60 or jsonb_typeof(x->'codes') is distinct from 'array'
       or coalesce((x->>'min')::integer, -1) not between 0 and 50 then
      raise exception 'Ligne de couverture invalide.';
    end if;
  end loop;
  update public.plan_settings set coverage = p_rows, updated_at = now(), updated_by = auth.uid() where id = 1;
  return p_rows;
end;
$$;

-- Comptes Onconic proposés pour relier une ligne (membres CHUV validés)
create or replace function public.plan_accounts() returns table (id uuid, name text, role text)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.can_edit_planning() then raise exception 'Réservé aux cadres administratifs.' using errcode = '42501'; end if;
  return query select p.id, public.member_name(p.id), p.role from public.profiles p
    where p.role not in ('member') and coalesce(p.institution, '') = 'CHUV' order by lower(public.member_name(p.id));
end;
$$;

revoke execute on function public.can_edit_planning(), public.plan_grid(date, date), public.plan_set_cells(jsonb), public.plan_staff_save(jsonb),
  public.plan_code_save(jsonb), public.plan_coverage_save(jsonb), public.plan_accounts() from public, anon;
grant execute on function public.can_edit_planning(), public.plan_grid(date, date), public.plan_set_cells(jsonb), public.plan_staff_save(jsonb),
  public.plan_code_save(jsonb), public.plan_coverage_save(jsonb), public.plan_accounts() to authenticated;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611160003') on conflict do nothing;
  end if;
end $$;

commit;
