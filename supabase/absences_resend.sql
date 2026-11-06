-- Absences : renvoyer l'e-mail de validation (rappel) aux validateurs qui n'ont pas encore décidé.
-- À exécuter après absences_validation.sql. Sans danger si relancé.
--  * absence_resend(ids) : pour les demandes en cours du membre (nouvelles absences ou demandes de changement), met en file un
--    rappel, un message par validateur (toutes les absences qu'il doit encore traiter), seulement aux validateurs « en attente » ;
--    sans validateur désigné, aux administrateurs. Un rappel par demande toutes les 10 minutes au plus.

alter table public.absences add column if not exists resent_at timestamptz;

-- Colonne ajoutée : on recrée absence_list pour que son type de retour suive la table
create or replace function public.absence_list(p_user uuid default null) returns setof public.absences
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid and not public.can_validate_absence(uid, p_user) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  return query select * from public.absences a where a.user_id = coalesce(p_user, uid)
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    and (a.status <> 'draft' or a.user_id = uid)
    order by a.start_date desc;
end;
$$;

-- Qui doit encore décider pour chaque absence : validateurs « en attente » encore habilités, à défaut les administrateurs
create or replace function public.absence_resend_pairs(p_user uuid, p_ids bigint[]) returns table (absence_id bigint, recipient uuid)
language sql stable security definer set search_path = public as $$
  select p.absence_id, p.validator_id from public.absence_approvals p
  where p.absence_id = any (p_ids) and p.decision = 'pending' and public.can_validate_absence(p.validator_id, p_user)
  union
  select i, ad.id from unnest(p_ids) i cross join public.profiles ad
  where ad.role = 'admin' and ad.id <> p_user
    and not exists (select 1 from public.absence_approvals p where p.absence_id = i and p.decision = 'pending' and public.can_validate_absence(p.validator_id, p_user));
$$;
revoke execute on function public.absence_resend_pairs(uuid, bigint[]) from public, anon, authenticated;

create or replace function public.absence_resend(p_ids bigint[] default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); mine bigint[]; fresh bigint[]; recips uuid[];
begin
  perform public.absence_guard();
  select coalesce(array_agg(a.id), '{}') into mine from public.absences a
    where a.user_id = uid and (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null))
      and (p_ids is null or a.id = any (p_ids));
  if cardinality(mine) = 0 then raise exception 'Aucune demande en cours à renvoyer.'; end if;
  select coalesce(array_agg(a.id), '{}') into fresh from public.absences a
    where a.id = any (mine) and (a.resent_at is null or a.resent_at < now() - interval '10 minutes');
  if cardinality(fresh) = 0 then raise exception 'Un rappel a déjà été envoyé il y a moins de 10 minutes.'; end if;
  select coalesce(array_agg(distinct r.recipient), '{}') into recips from public.absence_resend_pairs(uid, fresh) r;
  if cardinality(recips) = 0 then raise exception 'Aucun validateur à prévenir pour ces demandes.'; end if;
  insert into public.absence_outbox (kind, recipient, absence_ids, payload)
    select case when g.is_change then 'to_validate_change' else 'to_validate' end, g.recipient, g.ids,
           jsonb_build_object('owner', public.member_name(uid), 'reminder', true)
    from (select r.recipient, (a.change_type is not null) as is_change, array_agg(r.absence_id order by a.start_date) as ids
          from public.absence_resend_pairs(uid, fresh) r join public.absences a on a.id = r.absence_id
          group by r.recipient, (a.change_type is not null)) g;
  update public.absences set resent_at = now() where id = any (fresh);
  return jsonb_build_object('count', cardinality(fresh),
    'recipients', (select coalesce(jsonb_agg(public.member_name(x) order by public.member_name(x)), '[]'::jsonb) from unnest(recips) x));
end;
$$;
revoke execute on function public.absence_resend(bigint[]) from public, anon;
grant execute on function public.absence_resend(bigint[]) to authenticated;
