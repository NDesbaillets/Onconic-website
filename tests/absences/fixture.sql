-- Contrat Supabase minimal ; le code métier testé est chargé depuis les vrais scripts du dépôt.
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage;
create table auth.users(id uuid primary key,email text,last_sign_in_at timestamptz,created_at timestamptz default now(),raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
create table storage.buckets(id text primary key,name text,public boolean);
create table public.profiles(id uuid primary key references auth.users(id),full_name text,role text default 'member',institution text default 'CHUV',med_plus boolean default false,cdc_clinics text[] default '{}',first_name text,last_name text,phone text,lang text default 'fr',created_at timestamptz default now());
create function public.current_role_name() returns text language sql stable security definer as $$ select role from public.profiles where id=auth.uid() $$;
create function public.member_name(p_user uuid) returns text language sql stable security definer as $$ select full_name from public.profiles where id=p_user $$;
create function public.ch_today() returns date language sql stable as $$ select date '2026-11-11' $$;
create table public.tool_access(user_id uuid,tool text,allowed boolean,primary key(user_id,tool));
create table public.events(id bigint primary key,title text,start_date date,end_date date,in_absence_calendar boolean default false);
create table public.absence_calendar(id bigint generated always as identity primary key,kind text,label text,start_date date,end_date date,source text,to_confirm boolean default false);
create table public.calendar_sync(id int primary key,last_run timestamptz,last_result jsonb);
create table public.calendar_tokens(user_id uuid,token text);

create table storage.objects(id uuid,bucket_id text,name text);
