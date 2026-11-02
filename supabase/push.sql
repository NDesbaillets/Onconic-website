-- Notifications push (Web Push) : « un autre membre participe au même congrès que moi ».
-- À exécuter une fois dans le SQL Editor, avant de déployer le site qui l'utilise. Sans danger si relancé.

-- Consentement du membre (désactivé par défaut)
alter table public.profiles add column if not exists notify_events boolean not null default false;
grant update (notify_events) on public.profiles to authenticated;

-- Appareils abonnés : un abonnement par navigateur ou appareil. Le membre voit et supprime les siens ;
-- l'ajout passe par push_subscribe() (un appareil appartient au dernier membre qui l'active).
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists "push_subscriptions: own read" on public.push_subscriptions;
create policy "push_subscriptions: own read" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists "push_subscriptions: own delete" on public.push_subscriptions;
create policy "push_subscriptions: own delete" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
revoke all on public.push_subscriptions from anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100 then
    raise exception 'invalid_subscription';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_ua, 200))
  on conflict (endpoint) do update
    set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, created_at = now();
end;
$$;
revoke execute on function public.push_subscribe(text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text) to authenticated;

-- Une seule annonce par membre et par événement (évite les rafales si quelqu'un coche et décoche)
create table if not exists public.event_join_notices (
  event_id bigint not null references public.events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
alter table public.event_join_notices enable row level security;
revoke all on public.event_join_notices from anon, authenticated;

-- Clés VAPID : créées par la fonction « notify-event-join » au premier appel, lisibles par elle seule
-- (RLS sans règle et aucun droit pour les membres). Supprimer la ligne régénère les clés ;
-- chaque appareil doit alors réactiver les notifications.
create table if not exists public.push_config (
  id int primary key check (id = 1),
  vapid_public text not null,
  vapid_private text not null,
  created_at timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;
