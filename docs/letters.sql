-- 藏宝地图（js/68-treasure.js）用的表：AI 埋的纸条 + 用户标的命名地点。
-- 在你自己的 Supabase 项目上跑（SQL Editor 或 scripts/letter-hide.js --sql-file；全部可重复执行），改了这里要再跑一遍。
--
-- 权限设计：
--   只有登录用户能碰，且只能碰自己的（user_id = auth.uid()）；anon 什么都没有。
--   不给 delete：删除走 deleted_at 软删，两台设备各自的缓存才能对齐（硬删了另一台不知道）。
--   坐标是用户去过的地方，比聊天记录还敏感——表里只存用户自己标的点和纸条位置，不存行踪。

create table if not exists public.letters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null default 'letter' check (kind in ('letter', 'place')),
  place       text check (char_length(place) <= 60),
  lat         double precision check (lat between -90 and 90),
  lng         double precision check (lng between -180 and 180),
  radius_m    int  not null default 150 check (radius_m between 30 and 5000),
  title       text check (char_length(title) <= 120),
  body        text check (char_length(body) <= 8000),
  hidden_by   text check (hidden_by in ('cc', 'chat', 'user')),
  created_at  timestamptz not null default now(),
  found_at    timestamptz,
  deleted_at  timestamptz
);
create index if not exists letters_user_created on public.letters (user_id, created_at desc);

alter table public.letters enable row level security;

drop policy if exists letters_own_select on public.letters;
drop policy if exists letters_own_insert on public.letters;
drop policy if exists letters_own_update on public.letters;
create policy letters_own_select on public.letters for select to authenticated using (user_id = auth.uid());
create policy letters_own_insert on public.letters for insert to authenticated with check (user_id = auth.uid());
create policy letters_own_update on public.letters for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.letters from anon;
grant select, insert, update on public.letters to authenticated;
