-- Appliquer APRES les scripts historiques (voir README). Ne jamais relancer un ancien script ensuite.
begin;
do $$ begin
 if to_regclass('public.absence_opinions') is null or to_regclass('public.absence_decision_log') is null
 or to_regprocedure('public.absence_can_see(uuid,date,date)') is null then
  raise exception 'Installer les scripts historiques Absences (jusqu’à absences_preavis.sql et absences_visibilite.sql) avant cette migration.';
 end if;
end $$;
create table if not exists public.onconic_migrations(version text primary key, applied_at timestamptz not null default now());
revoke all on public.onconic_migrations from anon, authenticated;

-- 1. Affectations : choix initial libre, changements ultérieurs soumis à décision.
alter table public.profiles add column if not exists clinics_initialized boolean not null default false;
update public.profiles set clinics_initialized = true where cardinality(clinics) > 0 and not clinics_initialized;
create table if not exists public.clinic_requests (
 id bigint generated always as identity primary key, user_id uuid not null references public.profiles(id),
 clinics text[] not null, previous_clinics text[] not null default '{}', status text not null default 'pending' check(status in ('pending','approved','rejected','superseded')),
 requested_at timestamptz not null default now(), decided_at timestamptz, decided_by uuid, comment text
);
create unique index if not exists clinic_requests_pending on public.clinic_requests(user_id) where status='pending';
alter table public.clinic_requests enable row level security;
revoke all on public.clinic_requests from anon, authenticated;
create table if not exists public.member_clinic_history (
 id bigint generated always as identity primary key, user_id uuid not null references public.profiles(id),
 valid_from date not null, clinics text[] not null, recorded_at timestamptz not null default now(), actor uuid
);
alter table public.member_clinic_history enable row level security;
revoke all on public.member_clinic_history from anon, authenticated;
-- L'état antérieur au déploiement n'est pas reconstructible : commencer aujourd'hui.
insert into public.member_clinic_history(user_id,valid_from,clinics)
 select id,public.ch_today(),clinics from public.profiles p where not exists(select 1 from public.member_clinic_history h where h.user_id=p.id);
-- AFTER : le profil doit déjà exister pour la référence.
create or replace function public.clinic_history_record() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='INSERT' or new.clinics is distinct from old.clinics then
  insert into public.member_clinic_history(user_id,valid_from,clinics,actor) values(new.id,public.ch_today(),new.clinics,auth.uid());
 end if;
 return new;
end $$;
drop trigger if exists clinic_history_record on public.profiles;
create trigger clinic_history_record after insert or update of clinics on public.profiles for each row execute function public.clinic_history_record();

create or replace function public.my_set_clinics(p_clinics text[]) returns text[] language plpgsql security definer set search_path=public as $$
declare uid uuid:=auth.uid(); p public.profiles; v text[];
begin
 select * into p from public.profiles where id=uid for update;
 if not found or p.role not in ('clinician','cdc','cadre') then raise exception 'Réservé aux médecins.' using errcode='42501'; end if;
 v:=public.clinic_choice_check(p_clinics);
 if not p.clinics_initialized then
  update public.profiles set clinics=v,clinics_initialized=true where id=uid;
  perform public.absence_reroute(uid);
 elsif v is distinct from p.clinics then
  update public.clinic_requests set status='superseded',decided_at=now(),decided_by=uid where user_id=uid and status='pending';
  insert into public.clinic_requests(user_id,clinics,previous_clinics) values(uid,v,p.clinics);
 else
  update public.clinic_requests set status='superseded',decided_at=now(),decided_by=uid where user_id=uid and status='pending';
 end if;
 return v;
end $$;
create or replace function public.my_clinics() returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p public.profiles;
begin
 select * into p from public.profiles where id=auth.uid();
 if not found then raise exception 'Connexion requise.' using errcode='42501'; end if;
 return jsonb_build_object('role',p.role,'editable',p.role in ('clinician','cdc','cadre'),'initial',not p.clinics_initialized,
 'clinics',public.member_clinics(p.id),'options',(select jsonb_agg(clinic order by pos) from public.absence_clinic_settings where clinic<>'Administration'),
 'pending',(select to_jsonb(r) from public.clinic_requests r where r.user_id=p.id and status='pending'),
 'last_request',(select to_jsonb(r) from public.clinic_requests r where r.user_id=p.id order by id desc limit 1),
 'changes',coalesce((select jsonb_agg(to_jsonb(c) order by valid_from) from public.member_clinic_changes c where user_id=p.id and valid_from>public.ch_today()),'[]'::jsonb));
end $$;
create or replace function public.admin_clinic_requests() returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('name',public.member_name(r.user_id),'current',p.clinics) order by requested_at)
 from public.clinic_requests r join public.profiles p on p.id=r.user_id where r.status='pending'),'[]'::jsonb);
end $$;
create or replace function public.admin_clinic_request_decide(p_id bigint,p_approve boolean,p_comment text default null) returns void language plpgsql security definer set search_path=public as $$
declare r public.clinic_requests; p public.profiles;
begin
 if not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode='42501'; end if;
 select * into r from public.clinic_requests where id=p_id;
 if not found or r.status<>'pending' then raise exception 'Demande déjà traitée ou introuvable.'; end if;
 if r.user_id=auth.uid() then raise exception 'Vous ne pouvez pas décider votre propre demande.'; end if;
 select * into p from public.profiles where id=r.user_id for update;
 select * into r from public.clinic_requests where id=p_id for update;
 if not found or r.status<>'pending' then raise exception 'Demande déjà traitée.'; end if;
 if p_approve and r.previous_clinics is distinct from p.clinics then raise exception 'L’affectation a changé depuis la demande. Le membre doit renouveler sa demande.'; end if;
 if p.role not in ('clinician','cdc','cadre') then raise exception 'Ce membre n''est plus médecin.'; end if;
 if p_approve is null then raise exception 'Décision requise.'; end if;
 if not p_approve and length(trim(coalesce(p_comment,'')))<3 then raise exception 'Expliquez le refus.'; end if;
 if length(coalesce(p_comment,''))>500 then raise exception 'Commentaire trop long.'; end if;
 if p_approve then perform public.admin_set_clinics(r.user_id,r.clinics); end if;
 update public.clinic_requests set status=case when p_approve then 'approved' else 'rejected' end,decided_by=auth.uid(),decided_at=now(),comment=nullif(trim(p_comment),'') where id=p_id;
end $$;
-- Les champs d'affectation ne sont jamais modifiables directement via l'API de profils.
revoke update on public.profiles from authenticated,anon;
revoke update(clinics,clinics_initialized) on public.profiles from authenticated,anon;

-- Cliniques historiques + rotations futures ; les rotations appliquées ne sont plus perdues.
create or replace function public.member_clinics(p_user uuid,p_from date,p_to date) returns text[] language sql stable security definer set search_path=public as $$
 with events as (
  select distinct on (d) d,clinics from (
   select h.valid_from d,h.clinics,h.recorded_at stamp,h.id priority from public.member_clinic_history h where user_id=p_user
   union all select c.valid_from,c.clinics,c.created_at,9223372036854775807 from public.member_clinic_changes c where user_id=p_user
  ) e order by d,stamp desc,priority desc
 ), periods as (select d,clinics,lead(d) over(order by d) nxt from events)
 select coalesce((select case when p.role in ('clinician','cdc','cadre') then
  case when exists(select 1 from periods where d<=p_to and (nxt is null or nxt>p_from)) then array(select distinct x from periods cross join lateral unnest(clinics) x where d<=p_to and (nxt is null or nxt>p_from) order by x) else p.clinics end
  when p.role in ('assistant','pharmacist','direction','admin') then array['Administration'] else '{}'::text[] end
 from public.profiles p where id=p_user),'{}'::text[]);
$$;
create or replace function public.apply_clinic_changes() returns int language plpgsql security definer set search_path=public as $$
declare r record; n int:=0;
begin
 for r in select c.* from public.member_clinic_changes c where valid_from<=public.ch_today() order by valid_from,user_id for update loop
  insert into public.member_clinic_history(user_id,valid_from,clinics,actor) values(r.user_id,r.valid_from,r.clinics,r.created_by);
  update public.profiles set clinics=r.clinics,clinics_initialized=true where id=r.user_id and role in ('clinician','cdc','cadre');
  delete from public.member_clinic_changes where user_id=r.user_id and valid_from=r.valid_from;
  perform public.absence_reroute(r.user_id); n:=n+1;
 end loop;
 return n;
end $$;

-- 2. Chaque message ne contient que les demandes relevant de son destinataire.
create or replace function public.absence_enqueue(p_kind text,p_recipient uuid,p_ids bigint[],p_payload jsonb) returns void language plpgsql security definer set search_path=public as $$
declare ids bigint[];
begin
 select array_agg(a.id order by a.start_date,a.id) into ids from public.absences a where a.id=any(p_ids) and (
  case when p_kind in ('to_validate','to_validate_change') then
   p_recipient=any(public.absence_required_validators(a.user_id,public.absence_lo(a),public.absence_hi(a)))
   or (a.stage=2 and p_recipient=any(public.absence_direction_recipients(a.user_id)))
  when p_kind in ('approved','rejected','change_approved','change_rejected','direction_change') then p_recipient=a.user_id
  when p_kind='to_opinion' then p_recipient=any(public.absence_opinion_recipients(a.user_id))
  else false end);
 if ids is not null then insert into public.absence_outbox(kind,recipient,absence_ids,payload) values(p_kind,p_recipient,ids,coalesce(p_payload,'{}')); end if;
end $$;

create or replace function public.absence_notification_ids(p_recipient uuid,p_ids bigint[],p_kind text) returns bigint[] language sql stable security definer set search_path=public as $$
 select coalesce(array_agg(a.id order by a.start_date,a.id),'{}'::bigint[]) from public.absences a
 where a.id=any(p_ids) and public.tool_allowed(p_recipient,'absences') and case
 when p_kind in ('to_validate','to_validate_change') then
  (a.status='requested' or (a.status='approved' and a.change_type is not null)) and (
   (a.stage=1 and p_recipient=any(public.absence_required_validators(a.user_id,public.absence_lo(a),public.absence_hi(a))))
   or (a.stage=2 and p_recipient=any(public.absence_direction_recipients(a.user_id))))
 when p_kind='to_direction' then a.stage=2 and (a.status='requested' or (a.status='approved' and a.change_type is not null)) and p_recipient=any(public.absence_direction_recipients(a.user_id))
 when p_kind='to_opinion' then a.stage=1 and (a.status='requested' or (a.status='approved' and a.change_type is not null)) and p_recipient=any(public.absence_opinion_recipients(a.user_id))
 when p_kind in ('approved','rejected','change_approved','change_rejected','direction_change') then a.user_id=p_recipient
 else false end;
$$;
revoke execute on function public.absence_notification_ids(uuid,bigint[],text) from public,anon,authenticated;
grant execute on function public.absence_notification_ids(uuid,bigint[],text) to service_role;

create or replace function public.absence_enqueue_direction(p_ids bigint[], p_owner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid; oid bigint;
begin
  foreach r in array public.absence_direction_recipients(p_owner) loop
    select id into oid from public.absence_outbox
      where kind = 'to_direction' and recipient = r and sent_at is null and claimed_at is null
        and payload ->> 'owner_id' = p_owner::text and created_at > now() - interval '10 minutes'
      order by id desc limit 1 for update skip locked;
    if oid is not null then
      update public.absence_outbox set absence_ids = array(select distinct x from unnest(absence_ids || p_ids) x order by x) where id = oid;
    else
      insert into public.absence_outbox (kind, recipient, absence_ids, payload)
        values ('to_direction', r, p_ids, jsonb_build_object('owner', public.member_name(p_owner), 'owner_id', p_owner));
    end if;
  end loop;
end;
$$;

-- 3. Historique append-only : conserver les versions, y compris les validations effacées de la table opérationnelle.
create table if not exists public.absence_audit (
 id bigint generated always as identity primary key, absence_id bigint not null,user_id uuid not null,
 actor uuid,at timestamptz not null default now(),entity text not null,action text not null,before_data jsonb,after_data jsonb
);
create index if not exists absence_audit_subject on public.absence_audit(user_id,absence_id,id);
alter table public.absence_audit enable row level security;
revoke all on public.absence_audit from anon,authenticated;
create or replace function public.absence_audit_record() returns trigger language plpgsql security definer set search_path=public as $$
declare b jsonb; n jsonb; aid bigint; owner uuid;
begin
 if tg_op<>'INSERT' then b:=to_jsonb(old); end if;
 if tg_op<>'DELETE' then n:=to_jsonb(new); end if;
 if tg_table_name='absences' then
  if tg_op='UPDATE' and (n-array['notified_at','notified_decision_at','resent_at','form_queued_at'])=(b-array['notified_at','notified_decision_at','resent_at','form_queued_at']) then return new; end if;
  aid:=coalesce((n->>'id')::bigint,(b->>'id')::bigint); owner:=coalesce((n->>'user_id')::uuid,(b->>'user_id')::uuid);
 else
  aid:=coalesce((n->>'absence_id')::bigint,(b->>'absence_id')::bigint);
  select user_id into owner from public.absences where id=aid;
  if owner is null then select user_id into owner from public.absence_audit where absence_id=aid limit 1; end if;
 end if;
 insert into public.absence_audit(absence_id,user_id,actor,entity,action,before_data,after_data) values(aid,owner,auth.uid(),tg_table_name,tg_op,b,n);
 return coalesce(new,old);
end $$;
drop trigger if exists absence_audit on public.absences;
create trigger absence_audit after insert or update or delete on public.absences for each row execute function public.absence_audit_record();
drop trigger if exists absence_audit on public.absence_approvals;
create trigger absence_audit after insert or update or delete on public.absence_approvals for each row execute function public.absence_audit_record();
drop trigger if exists absence_audit on public.absence_opinions;
create trigger absence_audit after insert or update or delete on public.absence_opinions for each row execute function public.absence_audit_record();
create or replace function public.absence_history(p_id bigint) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare owner uuid;
begin
 perform public.absence_guard();
 select user_id into owner from public.absence_audit where absence_id=p_id order by id limit 1;
 if owner is null then return '[]'; end if;
 -- L'historique détaillé reste réservé à la personne et à l'administration ; aucun contournement de confidentialité.
 if owner<>auth.uid() and not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_name',public.member_name(actor)) order by id) from public.absence_audit a where absence_id=p_id),'[]');
end $$;

-- 4. Documents figés par version. Aucun texte libre médical dans les pièces jointes.
create table if not exists public.absence_documents (
 id bigint generated always as identity primary key,user_id uuid not null,absence_ids bigint[] not null,
 action text not null,created_at timestamptz not null default now(),data jsonb not null
);
alter table public.absence_documents enable row level security;
revoke all on public.absence_documents from anon,authenticated;
create or replace function public.absence_document_create(p_ids bigint[],p_action text) returns bigint language plpgsql security definer set search_path=public as $$
declare owner uuid; r text; doc bigint; d jsonb;
begin
 select user_id into owner from public.absences where id=any(p_ids) limit 1;
 if owner is null or exists(select 1 from public.absences where id=any(p_ids) and user_id<>owner) then return null; end if;
 select role into r from public.profiles where id=owner;
 if r not in ('clinician','cdc','cadre') then return null; end if;
 d:=jsonb_build_object('owner_id',owner,'owner',public.member_name(owner),'role',r,'action',p_action,
 'clinics',public.member_clinics(owner),'requested_at',(select min(coalesce(submitted_at,created_at)) from public.absences where id=any(p_ids)),
 'absences',(select jsonb_agg(jsonb_build_object('id',id,'kind',kind,'start_date',start_date,'end_date',end_date,'note',null,'status',status) order by start_date,id) from public.absences where id=any(p_ids)),
 'direction',(select jsonb_build_object('name',public.member_name(direction_by),'at',direction_at) from public.absences where id=any(p_ids) and direction_by is not null order by direction_at desc limit 1),
 'signers',coalesce((select jsonb_agg(jsonb_build_object('name',public.member_name(validator_id),'at',decided_at,'comment',null) order by decided_at) from public.absence_approvals where absence_id=any(p_ids) and decision='approved'),'[]'));
 insert into public.absence_documents(user_id,absence_ids,action,data) values(owner,p_ids,p_action,d) returning id into doc;
 return doc;
end $$;
-- La boîte d'envoi garde une référence vers le document, jamais une relecture de données mutables.
create or replace function public.absence_form_freeze() returns trigger language plpgsql security definer set search_path=public as $$
declare doc bigint; prior jsonb:='[]';
begin
 if tg_op='UPDATE' then prior:=coalesce(old.payload->'absences','[]'); end if;
 if new.kind='form' and not (new.payload ? 'document_id') then
  doc:=public.absence_document_create(new.absence_ids,coalesce(new.payload->>'action','approved'));
  new.payload:=new.payload||jsonb_build_object('document_id',doc);
 elsif new.kind<>'form' then
  new.payload:=(new.payload-'comment')||jsonb_build_object('absences',(
   select jsonb_agg(coalesce((select x from jsonb_array_elements(prior) x where (x->>'id')::bigint=a.id limit 1),
   jsonb_build_object('id',a.id,'user_id',user_id,'kind',kind,'start_date',start_date,'end_date',end_date,
    'note',null,'change_type',change_type,'change_kind',change_kind,'change_note',null,'change_start',change_start,'change_end',change_end)) order by start_date,a.id)
   from public.absences a where a.id=any(new.absence_ids)));
 end if;
 return new;
end $$;
drop trigger if exists absence_form_freeze on public.absence_outbox;
create trigger absence_form_freeze before insert or update of absence_ids on public.absence_outbox for each row execute function public.absence_form_freeze();
create or replace function public.absence_queue_correction(p_id bigint,p_action text) returns void language plpgsql security definer set search_path=public as $$
begin
 insert into public.absence_outbox(kind,recipient,absence_ids,payload) values('form',null,array[p_id],jsonb_build_object('action',p_action));
end $$;
create or replace function public.absence_form_access(p_caller uuid,p_ids bigint[]) returns boolean language sql stable security definer set search_path=public as $$
 select p_caller is not null and cardinality(p_ids)>0 and cardinality(p_ids)<=50
 and (select count(*) from public.absences where id=any(p_ids))=cardinality(p_ids)
 and (select count(distinct user_id) from public.absences where id=any(p_ids))=1
 and not exists(select 1 from public.absences a where id=any(p_ids) and not (
  a.user_id=p_caller or (select role from public.profiles where id=p_caller) in ('admin','direction')
  or public.can_validate_absence(p_caller,a.user_id,public.absence_lo(a),public.absence_hi(a))))
 and public.tool_allowed(p_caller,'absences');
$$;
create or replace function public.absence_form_data(p_ids bigint[]) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare d public.absence_documents;
begin
 select * into d from public.absence_documents where absence_ids @> p_ids order by id desc limit 1;
 if not found then return null; end if;
 return d.data||jsonb_build_object('document_id',d.id,'generated_at',d.created_at);
end $$;
create or replace function public.absence_document_data(p_document bigint) returns jsonb language sql stable security definer set search_path=public as $$
 select data||jsonb_build_object('document_id',id,'generated_at',created_at) from public.absence_documents where id=p_document;
$$;
create or replace function public.absence_document_access(p_caller uuid,p_document bigint) returns boolean language sql stable security definer set search_path=public as $$
 select coalesce((select public.absence_form_access(p_caller,absence_ids) from public.absence_documents where id=p_document),false);
$$;
create or replace function public.absence_document_versions(p_id bigint) returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 perform public.absence_guard();
 if not public.absence_form_access(auth.uid(),array[p_id]) then raise exception 'Accès refusé.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'action',action,'at',created_at) order by id desc) from public.absence_documents where p_id=any(absence_ids)),'[]');
end $$;
-- Reprise des documents en attente uniquement : ne pas fabriquer d'anciens signatures ou historiques.
update public.absence_outbox set payload=payload||jsonb_build_object('document_id',public.absence_document_create(absence_ids,'legacy_snapshot')) where kind='form' and sent_at is null and not (payload ? 'document_id');

-- Instantanés de reprise explicitement étiquetés, sans prétendre reconstruire le passé.
insert into public.absence_audit(absence_id,user_id,entity,action,after_data)
 select id,user_id,'absences','BASELINE',to_jsonb(a) from public.absences a
 where not exists(select 1 from public.absence_audit h where h.absence_id=a.id);
select public.absence_document_create(array[a.id],'legacy_snapshot') from public.absences a
 where not exists(select 1 from public.onconic_migrations where version='202611110001') and a.status='approved' and not exists(select 1 from public.absence_documents d where a.id=any(d.absence_ids));

-- 5. Boîte d'envoi : reprise espacée, état visible, traitement autonome.
alter table public.absence_outbox add column if not exists next_attempt_at timestamptz not null default now();
alter table public.absence_outbox add column if not exists skipped_at timestamptz;
create or replace function public.absence_outbox_claim(p_limit int default 30) returns setof public.absence_outbox language sql security definer set search_path=public as $$
 update public.absence_outbox o set claimed_at=now(),attempts=o.attempts+1
 where id in(select id from public.absence_outbox where sent_at is null and skipped_at is null and attempts<5 and next_attempt_at<=now()
 and (claimed_at is null or claimed_at<now()-interval '10 minutes') order by id limit greatest(1,least(p_limit,100)) for update skip locked) returning o.*;
$$;
create or replace function public.absence_outbox_done(p_id bigint,p_error text default null) returns void language sql security definer set search_path=public as $$
 update public.absence_outbox set sent_at=case when p_error is null then now() else null end,last_error=left(p_error,300),claimed_at=null,
 next_attempt_at=now()+make_interval(secs=>least(3600,60*power(2,attempts)::int)) where id=p_id;
$$;
create or replace function public.absence_notification_status() returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 perform public.absence_guard();
 return (select jsonb_build_object('pending',count(*) filter(where sent_at is null and skipped_at is null and attempts<5),
 'failed',count(*) filter(where sent_at is null and skipped_at is null and attempts>=5),'sent',count(*) filter(where sent_at is not null))
 from public.absence_outbox o where public.is_direction_admin() or o.recipient=auth.uid() or exists(select 1 from public.absences a where a.id=any(o.absence_ids) and a.user_id=auth.uid()));
end $$;
create or replace function public.absence_notification_failures() returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'kind',kind,'attempts',attempts,'created_at',created_at) order by id)
 from public.absence_outbox where sent_at is null and skipped_at is null and attempts>=5),'[]');
end $$;
create or replace function public.absence_notification_retry(p_id bigint) returns void language plpgsql security definer set search_path=public as $$
begin
 if not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode='42501'; end if;
 update public.absence_outbox set attempts=0,next_attempt_at=now(),claimed_at=null where id=p_id and sent_at is null and skipped_at is null and attempts>=5;
end $$;
create or replace function public.absence_outbox_skip(p_id bigint) returns void language sql security definer set search_path=public as $$
 update public.absence_outbox set skipped_at=now(),claimed_at=null,last_error=null where id=p_id;
$$;
revoke execute on function public.absence_outbox_skip(bigint) from public,anon,authenticated;
grant execute on function public.absence_outbox_skip(bigint) to service_role;
-- Le secret aléatoire absence_worker_token doit exister dans Vault ET ABSENCE_WORKER_TOKEN dans les Edge secrets.
-- Pas de clé service_role copiée dans le cron. L'appel worker ne sert qu'à vider la boîte d'envoi.
create or replace function public.absence_dispatch() returns boolean language plpgsql security definer set search_path=public as $$
declare token text; url text;
begin
 select decrypted_secret into token from vault.decrypted_secrets where name='absence_worker_token' limit 1;
 select decrypted_secret into url from vault.decrypted_secrets where name='absence_worker_url' limit 1;
 if token is null or url is null then return false; end if;
 perform net.http_post(url:=url,headers:=jsonb_build_object('Content-Type','application/json','x-absence-worker',token),body:='{}'::jsonb,timeout_milliseconds:=55000);
 return true;
end $$;
create or replace function public.absence_worker_health() returns jsonb language plpgsql stable security definer set search_path=public as $$
declare scheduled boolean:=false; configured boolean:=false;
begin
 if not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode='42501'; end if;
 if to_regclass('cron.job') is not null then execute 'select exists(select 1 from cron.job where jobname=''absence-outbox'' and active)' into scheduled; end if;
 if to_regclass('vault.decrypted_secrets') is not null then execute 'select count(distinct name)=2 from vault.decrypted_secrets where name in (''absence_worker_token'',''absence_worker_url'')' into configured; end if;
 return jsonb_build_object('scheduled',scheduled,'configured',configured);
end $$;
do $$ begin
 if exists(select 1 from pg_namespace where nspname='cron') then
  perform cron.schedule('absence-outbox','* * * * *','select public.absence_dispatch()');
 end if;
end $$;

-- 6. Décisions et documents rectificatifs.
create or replace function public.absence_finalize_approve(p_id bigint, p_by uuid, p_comment text) returns void
language plpgsql security definer set search_path = public as $$
declare a public.absences; k text := 'approved';
begin
  select * into a from public.absences where id = p_id for update;
  if a.change_type is null then
    update public.absences set status = 'approved', decision = 'approved', decision_comment = p_comment, decided_by = p_by, decided_at = now(),
      notified_decision_at = null where id = p_id;
  else
    k := 'change_approved';
    if a.change_type = 'delete' then
      update public.absences set status = 'cancelled', decision = 'change_approved' where id = p_id;
    else
      perform public.absence_check(a.user_id, p_id, a.change_kind, a.change_note, a.change_start, a.change_end);
      update public.absences set kind = change_kind, note = change_note, start_date = change_start, end_date = change_end,
        decision = 'change_approved' where id = p_id;
    end if;
    update public.absences set change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
      change_requested_at = null, decision_comment = p_comment, decided_by = p_by, decided_at = now(), notified_decision_at = null where id = p_id;
  end if;
  perform public.absence_enqueue(k, a.user_id, array[p_id], jsonb_build_object('by', case when p_by is null then null else public.member_name(p_by) end));
  if k = 'approved' then perform public.absence_form_after(p_id);
  else perform public.absence_queue_correction(p_id,case when a.change_type='delete' then 'cancelled' else 'modified' end); end if;
end;
$$;
create or replace function public.absence_direction_update(p_id bigint, p_kind text, p_note text, p_start date, p_end date, p_confidential boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences; conf boolean;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.status <> 'approved' then raise exception 'Seule une absence validée se modifie ici (une demande en cours se décide dans « À valider »).'; end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(a.user_id) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  perform public.absence_check(a.user_id, p_id, p_kind, n, p_start, p_end);
  conf := case when p_kind <> 'autre' then false else coalesce(p_confidential, a.confidential) end;
  update public.absences set kind = p_kind, note = n, start_date = p_start, end_date = p_end, confidential = conf,
    change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null, change_requested_at = null,
    stage = 1, direction_by = uid, direction_at = now(), notified_at = null, decision='change_approved',decided_by=uid,decided_at=clock_timestamp() where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'edited', 'by', public.member_name(uid)));
  end if;
  perform public.absence_queue_correction(p_id,'modified_direct');
  return jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(a.user_id, p_start, p_end),
                            'balance', public.absence_balance_check(a.user_id, p_kind, p_start, p_end, p_id));
end;
$$;
create or replace function public.absence_direction_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id for update;
  if not found or a.status not in ('approved', 'requested') then raise exception 'Absence introuvable ou déjà décidée.'; end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(a.user_id) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  update public.absences set status = 'cancelled', change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
    change_requested_at = null, stage = 1, decision='change_approved',decided_by=uid,decided_at=clock_timestamp(),direction_by=uid,direction_at=now() where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'cancelled', 'by', public.member_name(uid)));
  end if;
  perform public.absence_queue_correction(p_id,'cancelled_direct');
end;
$$;

-- Confidentialité appliquée aux API, pas seulement à leur affichage.
create or replace function public.absence_opinion_todo()
returns table (id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text,
  change_type text, change_kind text, change_note text, change_start date, change_end date, created_at timestamptz,
  conflicts jsonb, progress jsonb, my_opinion text, my_comment text, opinions jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then return; end if;
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, coalesce(a.change_requested_at, a.submitted_at, a.created_at),
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(p.validator_id), 'decision', p.decision, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then p.comment end, 'at', p.decided_at)
                     order by public.member_name(p.validator_id)) from public.absence_approvals p where p.absence_id = a.id), '[]'::jsonb),
           (select o.opinion from public.absence_opinions o where o.absence_id = a.id and o.user_id = auth.uid()),
           (select o.comment from public.absence_opinions o where o.absence_id = a.id and o.user_id = auth.uid()),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'opinion', o.opinion, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then o.comment end, 'at', o.updated_at)
                     order by o.updated_at) from public.absence_opinions o where o.absence_id = a.id and o.user_id <> auth.uid()), '[]'::jsonb)
    from public.absences a
    where a.stage = 1 and a.user_id <> auth.uid()
      and a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;
create or replace function public.absence_to_validate()
returns table (id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text,
  change_type text, change_kind text, change_note text, change_start date, change_end date, created_at timestamptz,
  change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb, stage int, opinions jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, coalesce(a.submitted_at, a.created_at), a.change_requested_at,
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select p.decision from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid()), 'pending'),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(p.validator_id), 'decision', p.decision, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then p.comment end, 'at', p.decided_at)
                     order by public.member_name(p.validator_id)) from public.absence_approvals p where p.absence_id = a.id), '[]'::jsonb),
           a.stage::int,
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'opinion', o.opinion, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then o.comment end, 'at', o.updated_at)
                     order by o.updated_at) from public.absence_opinions o where o.absence_id = a.id), '[]'::jsonb)
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.absence_actionable(auth.uid(), a)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;
create or replace function public.absence_list(p_user uuid default null) returns setof public.absences
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid and not (public.can_validate_absence(uid, p_user) or public.is_direction_admin()) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  return query select (jsonb_populate_record(null::public.absences, to_jsonb(a) || case when a.confidential and a.user_id <> uid and not public.is_direction_admin() then jsonb_build_object('note', null,'change_note',null,'decision_comment',null) else '{}'::jsonb end)).*
    from public.absences a where a.user_id = coalesce(p_user, uid)
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    and (a.status <> 'draft' or a.user_id = uid)
    order by a.start_date desc;
end;
$$;
create or replace function public.absence_export(p_from date, p_to date)
returns table (id bigint, user_id uuid, name text, role text, clinics text[], kind text, note text, start_date date, end_date date, status text, stage int,
  change_type text, change_kind text, change_note text, change_start date, change_end date, submitted_at timestamptz, decided_at timestamptz,
  decided_by_name text, decision_comment text, approvers text, direction_name text, direction_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select a.id, a.user_id, public.member_name(a.user_id), (select p.role from public.profiles p where p.id = a.user_id),
           public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status, a.stage::int,
           a.change_type, a.change_kind, case when not a.confidential or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, a.submitted_at, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end, case when not a.confidential or public.is_direction_admin() then a.decision_comment end,
           (select string_agg(public.member_name(x.validator_id) || ' (' || to_char(x.decided_at at time zone 'Europe/Zurich', 'DD.MM.YYYY HH24:MI') || ')', ', ' order by x.decided_at)
              from public.absence_approvals x where x.absence_id = a.id and x.decision = 'approved' and x.decided_at is not null),
           case when a.direction_by is null then null else public.member_name(a.direction_by) end, a.direction_at
    from public.absences a
    where a.status <> 'draft' and a.start_date <= p_to and a.end_date >= p_from
      and (public.is_direction_admin() or public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)))
    order by public.member_name(a.user_id), a.start_date, a.id;
end;
$$;
create or replace function public.absence_decisions(p_from date, p_to date)
returns table (user_id uuid, name text, role text, clinics text[], decision text, kind text, note text, start_date date, end_date date,
  decided_at timestamptz, decided_by_name text, comment text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select l.user_id, public.member_name(l.user_id), (select p.role from public.profiles p where p.id = l.user_id),
           public.member_clinics(l.user_id, l.start_date, l.end_date), l.decision, l.kind, case when not l.confidential or public.is_direction_admin() then l.note end, l.start_date, l.end_date, l.decided_at,
           case when l.decided_by is null then null else public.member_name(l.decided_by) end, case when not l.confidential or public.is_direction_admin() then l.comment end
    from public.absence_decision_log l
    where l.start_date <= p_to and l.end_date >= p_from
      and (public.is_direction_admin() or public.can_validate_absence(auth.uid(), l.user_id, l.start_date, l.end_date))
    order by public.member_name(l.user_id), l.decided_at;
end;
$$;
create or replace function public.absence_calendar_feed(p_token text)
returns table (id bigint, kind text, note text, status text, start_date date, end_date date, change_type text, updated_at timestamptz, user_key text)
language sql stable security definer set search_path = public as $$
  select a.id, a.kind, null::text, a.status, a.start_date, a.end_date, a.change_type,
         coalesce(a.decided_at, a.submitted_at, a.created_at), t.user_id::text
  from public.calendar_tokens t
  join public.absences a on a.user_id = t.user_id
  where t.token = p_token and public.tool_allowed(t.user_id, 'absences') and a.status in ('requested', 'approved')
  order by a.start_date;
$$;

create or replace function public.clinic_initialization_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if old.clinics_initialized and not new.clinics_initialized then raise exception 'Initialisation irréversible.'; end if;
 if new.clinics is distinct from old.clinics then new.clinics_initialized:=true; end if;
 return new;
end $$;
drop trigger if exists clinic_initialization_guard on public.profiles;
create trigger clinic_initialization_guard before update of clinics,clinics_initialized on public.profiles for each row execute function public.clinic_initialization_guard();

-- Toutes les fonctions internes sont privées, même nouvellement créées (EXECUTE PUBLIC par défaut dans PostgreSQL).
do $$ declare sig text; begin
 foreach sig in array array[
 'clinic_history_record()','clinic_initialization_guard()','absence_audit_record()',
 'absence_enqueue(text,uuid,bigint[],jsonb)','absence_document_create(bigint[],text)','absence_form_freeze()',
 'absence_queue_correction(bigint,text)','absence_finalize_approve(bigint,uuid,text)','apply_clinic_changes()',
 'absence_dispatch()','absence_form_data(bigint[])','absence_document_data(bigint)',
 'absence_form_access(uuid,bigint[])','absence_document_access(uuid,bigint)',
 'absence_outbox_claim(int)','absence_outbox_done(bigint,text)','absence_calendar_feed(text)'] loop
 execute format('revoke execute on function public.%s from public, anon, authenticated',sig);
 end loop;
 foreach sig in array array['my_set_clinics(text[])','my_clinics()','admin_clinic_requests()',
 'admin_clinic_request_decide(bigint,boolean,text)','absence_history(bigint)','absence_document_versions(bigint)',
 'absence_notification_status()','absence_notification_failures()','absence_notification_retry(bigint)','absence_worker_health()'] loop
 execute format('revoke execute on function public.%s from public, anon',sig);
 execute format('grant execute on function public.%s to authenticated',sig);
 end loop;
end $$;
grant execute on function public.absence_form_data(bigint[]),public.absence_document_data(bigint),public.absence_form_access(uuid,bigint[]),public.absence_document_access(uuid,bigint),public.absence_outbox_claim(int),public.absence_outbox_done(bigint,text),public.absence_calendar_feed(text) to service_role;
insert into public.onconic_migrations(version) values('202611110001') on conflict do nothing;
commit;
