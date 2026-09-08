-- Run this in Supabase SQL Editor.
-- The Node backend uses the SERVICE ROLE key server-side.

create table if not exists public.wa_accounts (
  id text primary key,
  customer_name text not null,
  phone text not null unique,
  status text not null default 'disconnected',
  bot_enabled boolean not null default true,
  bot_online boolean not null default false,
  model text not null,
  prompt text not null,
  created_at timestamptz not null,
  last_seen_at timestamptz,
  messages_received bigint not null default 0,
  messages_sent bigint not null default 0,
  ai_requests bigint not null default 0,
  last_message text
);

create table if not exists public.wa_messages (
  id text primary key,
  account_id text not null references public.wa_accounts(id) on delete cascade,
  jid text not null,
  role text not null check (role in ('user','assistant')),
  text text not null,
  time timestamptz not null
);
create index if not exists wa_messages_account_jid_time_idx on public.wa_messages(account_id, jid, time desc);

create table if not exists public.wa_contact_states (
  id text primary key,
  account_id text not null references public.wa_accounts(id) on delete cascade,
  jid text not null,
  ai_enabled boolean not null default true,
  human_takeover boolean not null default false,
  updated_at timestamptz not null,
  unique(account_id, jid)
);

create table if not exists public.wa_knowledge (
  id text primary key,
  account_id text not null references public.wa_accounts(id) on delete cascade,
  type text not null,
  title text not null,
  description text not null default '',
  price text,
  image_url text,
  product_url text,
  file_url text,
  category text,
  tags jsonb not null default '[]'::jsonb,
  available boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists wa_knowledge_account_idx on public.wa_knowledge(account_id);

create table if not exists public.wa_logs (
  id text primary key,
  account_id text references public.wa_accounts(id) on delete cascade,
  time timestamptz not null,
  type text not null,
  message text not null
);
create index if not exists wa_logs_time_idx on public.wa_logs(time desc);

-- Storage bucket for knowledge-base media.
insert into storage.buckets (id, name, public)
values ('knowledge', 'knowledge', true)
on conflict (id) do nothing;

-- Recommended production policy: keep dashboard/backend operations server-side.
-- Do not expose SUPABASE_SERVICE_ROLE_KEY to the browser.

-- V4 business features
alter table public.wa_contact_states add column if not exists stage text not null default 'new';
alter table public.wa_contact_states add column if not exists notes text not null default '';

create table if not exists public.wa_business_profiles (
  account_id text primary key references public.wa_accounts(id) on delete cascade,
  business_name text not null default '',
  description text not null default '',
  location text not null default '',
  currency text not null default 'TZS',
  phone text not null default '',
  working_hours text not null default '',
  website text not null default '',
  sales_behavior text not null default 'helpful',
  updated_at timestamptz not null
);

create table if not exists public.wa_orders (
  id text primary key,
  account_id text not null references public.wa_accounts(id) on delete cascade,
  jid text not null,
  customer_name text not null,
  product text not null,
  quantity integer not null default 1,
  unit_price text not null default '',
  total_price text not null default '',
  status text not null default 'pending',
  notes text not null default '',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists wa_orders_account_created_idx on public.wa_orders(account_id, created_at desc);
create index if not exists wa_orders_jid_idx on public.wa_orders(account_id, jid);


-- V5 MULTI-TENANT FOUNDATION
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  phone text,
  role text not null default 'owner' check (role in ('admin','owner')),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role = 'owner'),
  created_at timestamptz not null default now(),
  unique(business_id,user_id)
);

alter table public.wa_accounts add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.wa_messages add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.wa_contact_states add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.wa_knowledge add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.wa_logs add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.wa_business_profiles add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.wa_orders add column if not exists business_id uuid references public.businesses(id) on delete cascade;

create index if not exists wa_accounts_business_idx on public.wa_accounts(business_id);
create index if not exists business_members_user_idx on public.business_members(user_id);
create index if not exists business_members_business_idx on public.business_members(business_id);

-- V15 SIMPLE OWNER MODEL
-- Zetiora has only two application roles: system admin and business owner.
-- Legacy manager/staff memberships are removed. If legacy data contains
-- multiple memberships, keep the oldest membership so the migration preserves
-- one stable owner relationship without deleting the business itself.
delete from public.business_members where role <> 'owner';
with ranked as (
  select id, row_number() over (partition by business_id order by created_at asc, id asc) as rn
  from public.business_members
)
delete from public.business_members bm using ranked r where bm.id = r.id and r.rn > 1;
with ranked as (
  select id, row_number() over (partition by user_id order by created_at asc, id asc) as rn
  from public.business_members
)
delete from public.business_members bm using ranked r where bm.id = r.id and r.rn > 1;
update public.business_members set role = 'owner' where role <> 'owner';
update public.profiles set role = 'owner' where role not in ('admin','owner');
create unique index if not exists business_members_one_business_per_user_uidx
  on public.business_members(user_id);
create unique index if not exists business_members_one_owner_per_business_uidx
  on public.business_members(business_id);
create unique index if not exists wa_accounts_one_per_business_uidx
  on public.wa_accounts(business_id) where business_id is not null;

-- Enable RLS for tenant tables. Service-role backend operations remain server-side.
alter table public.businesses enable row level security;
alter table public.profiles enable row level security;
alter table public.business_members enable row level security;

create or replace function public.is_business_member(target_business uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.business_members where business_id=target_business and user_id=auth.uid()); $$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='business_members' and policyname='business_members_self_or_member') then
    create policy business_members_self_or_member on public.business_members for select using (user_id=auth.uid() or public.is_business_member(business_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='businesses' and policyname='businesses_member_select') then
    create policy businesses_member_select on public.businesses for select using (public.is_business_member(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_self_select') then
    create policy profiles_self_select on public.profiles for select using (id=auth.uid());
  end if;
end $$;

-- V15.1 ACCOUNT LIFECYCLE + ADMIN RLS
-- Backfill profiles for existing Auth users so role resolution never returns NULL.
insert into public.profiles(id,email,full_name,phone,role,status)
select id,email,coalesce(raw_user_meta_data->>'full_name',''),coalesce(raw_user_meta_data->>'phone',''),'owner','active'
from auth.users
on conflict (id) do nothing;

-- Normalize legacy account rows before enforcing the new lifecycle.
update public.profiles set role='owner' where role is null or role not in ('admin','owner');
update public.profiles set status='active' where status is null or status not in ('active','suspended');
update public.businesses set status='active' where status is null or status not in ('active','suspended');


alter table public.profiles add column if not exists status text not null default 'active';
alter table public.businesses add column if not exists status text not null default 'active';

create or replace function public.is_system_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id=auth.uid() and role='admin' and status='active'); $$;

create or replace function public.handle_new_user_profile() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id,email,full_name,phone,role,status)
  values(new.id,new.email,coalesce(new.raw_user_meta_data->>'full_name',''),coalesce(new.raw_user_meta_data->>'phone',''),'owner','active')
  on conflict(id) do update set email=excluded.email, full_name=coalesce(nullif(excluded.full_name,''),public.profiles.full_name), phone=coalesce(nullif(excluded.phone,''),public.profiles.phone);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users for each row execute function public.handle_new_user_profile();

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='businesses' and policyname='businesses_admin_all') then
    create policy businesses_admin_all on public.businesses for all using (public.is_system_admin()) with check (public.is_system_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_admin_all') then
    create policy profiles_admin_all on public.profiles for all using (public.is_system_admin()) with check (public.is_system_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='business_members' and policyname='business_members_admin_all') then
    create policy business_members_admin_all on public.business_members for all using (public.is_system_admin()) with check (public.is_system_admin());
  end if;
end $$;

-- V6 TENANT ACCESS HARDENING
create index if not exists wa_accounts_business_phone_idx on public.wa_accounts(business_id, phone);
create index if not exists wa_messages_business_time_idx on public.wa_messages(business_id, time desc);
create index if not exists wa_knowledge_business_idx on public.wa_knowledge(business_id, updated_at desc);
create index if not exists wa_orders_business_idx on public.wa_orders(business_id, created_at desc);
create index if not exists wa_logs_business_time_idx on public.wa_logs(business_id, time desc);

alter table public.wa_accounts enable row level security;
alter table public.wa_messages enable row level security;
alter table public.wa_contact_states enable row level security;
alter table public.wa_knowledge enable row level security;
alter table public.wa_logs enable row level security;
alter table public.wa_business_profiles enable row level security;
alter table public.wa_orders enable row level security;

create or replace function public.is_business_admin(target_business uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from public.business_members
  where business_id=target_business and user_id=auth.uid() and role = 'owner'
); $$;

-- Read policies for authenticated tenant members. Writes remain server-side through service role.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_accounts' and policyname='wa_accounts_member_select') then
    create policy wa_accounts_member_select on public.wa_accounts for select using (public.is_business_member(business_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_messages' and policyname='wa_messages_member_select') then
    create policy wa_messages_member_select on public.wa_messages for select using (public.is_business_member(business_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_contact_states' and policyname='wa_contact_states_member_select') then
    create policy wa_contact_states_member_select on public.wa_contact_states for select using (public.is_business_member(business_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_knowledge' and policyname='wa_knowledge_member_select') then
    create policy wa_knowledge_member_select on public.wa_knowledge for select using (public.is_business_member(business_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_business_profiles' and policyname='wa_business_profiles_member_select') then
    create policy wa_business_profiles_member_select on public.wa_business_profiles for select using (public.is_business_member(business_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_orders' and policyname='wa_orders_member_select') then
    create policy wa_orders_member_select on public.wa_orders for select using (public.is_business_member(business_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_logs' and policyname='wa_logs_member_select') then
    create policy wa_logs_member_select on public.wa_logs for select using (public.is_business_member(business_id));
  end if;
end $$;

-- V9 SALES AUTOMATION
alter table public.wa_orders add column if not exists product_id text references public.wa_knowledge(id) on delete set null;
alter table public.wa_orders add column if not exists source text not null default 'manual' check (source in ('manual','ai'));
create index if not exists wa_orders_product_idx on public.wa_orders(account_id, product_id);


-- V10 production hardening
alter table public.wa_orders drop constraint if exists wa_orders_quantity_positive;
alter table public.wa_orders add constraint wa_orders_quantity_positive check (quantity between 1 and 10000);
create index if not exists wa_orders_business_status_idx on public.wa_orders(business_id, status, created_at desc);
create index if not exists wa_knowledge_business_available_idx on public.wa_knowledge(business_id, available, updated_at desc);

-- V11 AI COMMERCE ENGINE
create table if not exists public.wa_customers (
  id text primary key,
  account_id text not null references public.wa_accounts(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  jid text not null,
  name text not null default '',
  phone text not null default '',
  area text not null default '',
  address text not null default '',
  instructions text not null default '',
  updated_at timestamptz not null default now(),
  unique(account_id,jid)
);
create index if not exists wa_customers_business_idx on public.wa_customers(business_id,updated_at desc);

create table if not exists public.wa_carts (
  id text primary key,
  account_id text not null references public.wa_accounts(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  jid text not null,
  customer_name text not null default '',
  items jsonb not null default '[]'::jsonb,
  checkout_token text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id,jid)
);
create index if not exists wa_carts_business_idx on public.wa_carts(business_id,updated_at desc);
create index if not exists wa_carts_token_idx on public.wa_carts(checkout_token);

alter table public.wa_customers enable row level security;
alter table public.wa_carts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_customers' and policyname='wa_customers_member_select') then
    create policy wa_customers_member_select on public.wa_customers for select using (public.is_business_member(business_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='wa_carts' and policyname='wa_carts_member_select') then
    create policy wa_carts_member_select on public.wa_carts for select using (public.is_business_member(business_id));
  end if;
end $$;

-- V13 STRUCTURED PRODUCT MEDIA + ACTIONS
alter table public.wa_knowledge add column if not exists image_urls jsonb not null default '[]'::jsonb;
alter table public.wa_knowledge add column if not exists actions jsonb not null default '[]'::jsonb;

-- V14 PRODUCTION RELIABILITY
alter table public.wa_orders add column if not exists idempotency_key text;
create unique index if not exists wa_orders_account_idempotency_product_uidx
  on public.wa_orders(account_id, idempotency_key, product_id)
  where idempotency_key is not null;
create index if not exists wa_orders_business_idempotency_idx
  on public.wa_orders(business_id, idempotency_key)
  where idempotency_key is not null;

-- Prevent invalid checkout bearer tokens from being accidentally reused as an
-- empty value. Existing rows are preserved; new carts should always carry a
-- high-entropy token from the application.
update public.wa_carts set checkout_token = encode(gen_random_bytes(32), 'base64')
where checkout_token = '';

-- Keep tenant access checks explicit and immutable at the database boundary.
create index if not exists business_members_user_business_role_idx
  on public.business_members(user_id, business_id, role);

-- V14.1 persist checkout token creation time for exact TTL enforcement
alter table public.wa_carts add column if not exists checkout_token_created_at timestamptz;


-- V14.2 COMMERCE FUNCTIONALITY
alter table public.wa_knowledge add column if not exists stock integer;
alter table public.wa_knowledge add column if not exists sku text;
alter table public.wa_knowledge add column if not exists variants jsonb not null default '[]'::jsonb;
alter table public.wa_knowledge add constraint wa_knowledge_stock_nonnegative check (stock is null or stock >= 0);
create index if not exists wa_knowledge_business_sku_idx on public.wa_knowledge(business_id, sku) where sku is not null;

alter table public.wa_orders add column if not exists payment_status text not null default 'pending' check (payment_status in ('pending','paid','failed','refunded'));
alter table public.wa_orders add column if not exists fulfillment_status text not null default 'unfulfilled' check (fulfillment_status in ('unfulfilled','processing','shipped','delivered','failed'));
alter table public.wa_orders add column if not exists delivery jsonb not null default '{}'::jsonb;
create index if not exists wa_orders_payment_status_idx on public.wa_orders(business_id, payment_status, created_at desc);
create index if not exists wa_orders_fulfillment_status_idx on public.wa_orders(business_id, fulfillment_status, created_at desc);

-- V14.4 PRODUCT IMAGE STORAGE
-- Create this public bucket once in Supabase. The backend uses the service role
-- to upload; product image URLs are public so customer checkout can display them.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = excluded.public;


-- V15 STORAGE POLICIES
-- Product images are uploaded by the server using the service role. The bucket
-- remains public for customer checkout/product display; browser writes are not granted.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='product_images_public_read') then
    create policy product_images_public_read on storage.objects for select using (bucket_id = 'product-images');
  end if;
end $$;
