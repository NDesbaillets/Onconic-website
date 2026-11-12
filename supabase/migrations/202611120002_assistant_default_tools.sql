-- Assistantes médicales : Congrès, Absences et Key trials ne sont plus accessibles par défaut (12.11.2026).
-- Les autres outils restent ouverts (Formation, Annuaires, Lettres d'assurance et Durée avec CHUV).
-- L'admin peut toujours rouvrir un outil à une assistante par exception (tool_access). Aucune donnée n'est touchée.
-- Partant de la définition en production après 202611120001. Réexécutable.
begin;

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
    when 'absences' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'congres' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'cadre', 'pharmacist', 'nurse')
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

insert into public.onconic_migrations(version) values ('202611120002') on conflict do nothing;
commit;
