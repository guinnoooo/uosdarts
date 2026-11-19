-- 043: a password for match chat
--
-- Chat can only be read or written after entering the chat password
-- (FatBastard to start with; the super admin can change it). Entering it
-- unlocks chat for that browser's sign-in until the password changes. Rows
-- are protected by row level security, so live updates only reach people
-- who've unlocked it too. Admins can always see chat.
--
-- Run after migration-042.sql. Safe to run more than once.

create table if not exists public.chat_access (
  user_id uuid primary key,
  version int not null,
  unlocked_at timestamptz not null default now()
);
alter table public.chat_access enable row level security;   -- no policies: reached only through the functions below

insert into public.settings (key, value) values ('chat_pw', extensions.crypt('FatBastard', extensions.gen_salt('bf')))
  on conflict (key) do nothing;
insert into public.settings (key, value) values ('chat_pw_version', '1')
  on conflict (key) do nothing;

-- Has the signed-in user unlocked chat with the current password?
create or replace function public.chat_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    exists (select 1 from chat_access a
             where a.user_id = auth.uid()
               and a.version = (select value::int from settings where key = 'chat_pw_version'))
    or is_admin());
$$;

create or replace function public.chat_unlock(p_password text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  select value into h from settings where key = 'chat_pw';
  if p_password is null or h is null or crypt(btrim(p_password), h) <> h then
    raise exception 'Wrong chat password';
  end if;
  insert into chat_access (user_id, version)
  values (auth.uid(), (select value::int from settings where key = 'chat_pw_version'))
  on conflict (user_id) do update set version = excluded.version, unlocked_at = now();
  return true;
end $$;

create or replace function public.super_set_chat_password(p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if length(btrim(coalesce(p_password, ''))) < 4 then raise exception 'At least 4 characters'; end if;
  update settings set value = crypt(btrim(p_password), gen_salt('bf')) where key = 'chat_pw';
  -- Everyone has to enter the new one.
  update settings set value = (value::int + 1)::text where key = 'chat_pw_version';
end $$;

-- Reading chat now needs it unlocked.
drop policy if exists "chat readable" on public.match_chat;
create policy "chat readable" on public.match_chat for select using ((select chat_ok()));

-- So does posting.
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.post_chat(uuid, text, text)'::regprocedure), E'\r', '');
  if position('chat_ok()' in def) = 0 then
    def := replace(def, $r$if auth.uid() is null then raise exception 'You need to be signed in to chat'; end if;$r$,
      $r$if auth.uid() is null then raise exception 'You need to be signed in to chat'; end if;
  if not chat_ok() then raise exception 'Enter the chat password first'; end if;$r$);
    if position('chat_ok()' in def) = 0 then raise exception 'post_chat has changed shape'; end if;
    execute def;
  end if;
end $$;

revoke execute on function public.chat_unlock(text) from public, anon;
revoke execute on function public.super_set_chat_password(text) from public, anon;
grant  execute on function public.chat_ok() to anon, authenticated;
grant  execute on function public.chat_unlock(text) to authenticated;
grant  execute on function public.super_set_chat_password(text) to authenticated;
