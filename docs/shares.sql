-- 分享对话（js/59-share.js）用的表。在你自己的 Supabase 项目上跑一次（SQL Editor）。
-- 改了这里要再跑一遍（全部可重复执行）。
--
-- 权限设计：
--   匿名访客（查看页，GRANCYAN_CONFIG.sharePageUrl 指向的那个静态页）对表**没有** select 权限，只能调 get_share(id) 拿那一条——
--   否则拿着公开的 anon key 就能 select * 把所有人分享过的对话列出来。
--   登录用户只能插入/查看/删除自己的（user_id = auth.uid()）。删除＝撤回，链接立刻失效。

create table if not exists public.shares (
  id          text primary key check (id ~ '^[A-Za-z0-9]{6,32}$'),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text check (char_length(title) <= 200),
  n           int  not null default 0,
  payload     jsonb not null check (pg_column_size(payload) < 400000),
  created_at  timestamptz not null default now()
);
create index if not exists shares_user_created on public.shares (user_id, created_at desc);

alter table public.shares enable row level security;

drop policy if exists shares_own_select on public.shares;
drop policy if exists shares_own_insert on public.shares;
drop policy if exists shares_own_delete on public.shares;
create policy shares_own_select on public.shares for select to authenticated using (user_id = auth.uid());
create policy shares_own_insert on public.shares for insert to authenticated with check (user_id = auth.uid());
create policy shares_own_delete on public.shares for delete to authenticated using (user_id = auth.uid());

revoke all on public.shares from anon;

create or replace function public.get_share(sid text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('title', s.title, 'payload', s.payload, 'created_at', s.created_at)
  from public.shares s
  where s.id = sid
$$;
revoke all on function public.get_share(text) from public;
grant execute on function public.get_share(text) to anon, authenticated;
