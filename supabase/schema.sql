-- Hooky schema for Supabase (Postgres 15+).
-- Every safety rule the client enforces is enforced again here, because the
-- client can be modified by anyone. Apply in the Supabase SQL editor.
--
-- Design note on age brackets: a person's bracket changes as they age, so it is
-- computed at query time from birthdate, never stored. An earlier version of
-- this file used a STORED generated column, which froze each user's bracket at
-- signup and would have left adults visible to minors after a birthday.

create extension if not exists pgcrypto;

-- ---------- enums ----------
do $$ begin
  create type age_bracket as enum ('13-15', '16-17', '18-20', '21+');
exception when duplicate_object then null; end $$;
do $$ begin
  create type swipe_dir as enum ('like', 'nope');
exception when duplicate_object then null; end $$;
do $$ begin
  create type verification_state as enum ('none', 'pending', 'estimated', 'verified', 'failed');
exception when duplicate_object then null; end $$;
do $$ begin
  create type gender as enum ('woman', 'man', 'nonbinary', 'other');
exception when duplicate_object then null; end $$;

-- ---------- helpers ----------
-- STABLE, not IMMUTABLE: the result depends on today's date.
create or replace function bracket_for(birthdate date) returns age_bracket
language sql stable as $$
  select case
    when birthdate is null then null
    when extract(year from age(birthdate))::int < 13 then null
    when extract(year from age(birthdate))::int <= 15 then '13-15'::age_bracket
    when extract(year from age(birthdate))::int <= 17 then '16-17'::age_bracket
    when extract(year from age(birthdate))::int <= 20 then '18-20'::age_bracket
    else '21+'::age_bracket end
$$;

create or replace function years_old(birthdate date) returns int
language sql stable as $$ select extract(year from age(birthdate))::int $$;

-- ---------- tables ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 20),
  birthdate date not null,
  emoji text,
  photo_url text,
  region text check (char_length(region) <= 30),
  bio text check (char_length(bio) <= 140),
  interests text[] default '{}',
  verification verification_state not null default 'none',
  premium_until timestamptz,
  banned_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Added after the first release, so these use ADD COLUMN IF NOT EXISTS to keep
-- this file safe to re-run against an existing database.
alter table profiles add column if not exists gender gender;
alter table profiles add column if not exists show_me gender[] not null default enum_range(null::gender);
alter table profiles add column if not exists verification_provider text;
alter table profiles add column if not exists verified_at timestamptz;
alter table profiles add column if not exists age_estimate_low int;
alter table profiles add column if not exists age_estimate_high int;

-- Minimum age is enforced in a trigger, because a CHECK constraint may only
-- call IMMUTABLE functions and age depends on the current date.
-- client_write distinguishes a direct request from the app (which runs as the
-- "authenticated" role) from a SECURITY DEFINER function or the service role
-- key (which run as the owner). Trusted server code must stay able to grant
-- verification and premium, so only client writes get those fields locked.
create or replace function profiles_guard() returns trigger language plpgsql as $$
declare client_write boolean := current_user in ('authenticated', 'anon');
begin
  if bracket_for(new.birthdate) is null then
    raise exception 'must be at least 13 years old';
  end if;
  if tg_op = 'UPDATE' then
    -- Birthdate is write-once. Nobody ages themselves into another group.
    if new.birthdate is distinct from old.birthdate then
      raise exception 'birthdate cannot be changed';
    end if;
    if client_write then
      new.verification := old.verification;
      new.premium_until := old.premium_until;
      new.banned_at := old.banned_at;
    end if;
  elsif client_write then
    new.verification := 'none';
    new.premium_until := null;
    new.banned_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_guard_trg on profiles;
create trigger profiles_guard_trg before insert or update on profiles
  for each row execute function profiles_guard();

create table if not exists swipes (
  swiper_id uuid references profiles(id) on delete cascade,
  target_id uuid references profiles(id) on delete cascade,
  dir swipe_dir not null,
  created_at timestamptz default now(),
  primary key (swiper_id, target_id)
);
create index if not exists swipes_target on swipes(target_id) where dir = 'like';
create index if not exists swipes_recent_likes on swipes(swiper_id, created_at) where dir = 'like';

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  a uuid references profiles(id) on delete cascade,
  b uuid references profiles(id) on delete cascade,
  created_at timestamptz default now(),
  unique (a, b),
  check (a < b)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references matches(id) on delete cascade,
  sender_id uuid references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz default now()
);
create index if not exists messages_match on messages(match_id, created_at);

create table if not exists reads (
  match_id uuid references matches(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  last_read_at timestamptz default now(),
  primary key (match_id, user_id)
);

create table if not exists blocks (
  blocker_id uuid references profiles(id) on delete cascade default auth.uid(),
  blocked_id uuid references profiles(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (blocker_id, blocked_id)
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references profiles(id) on delete set null default auth.uid(),
  reported_id uuid references profiles(id) on delete cascade,
  reason text not null,
  details text,
  status text default 'open',
  created_at timestamptz default now()
);
create index if not exists reports_open on reports(status, created_at);

-- Written by the payment webhook (App Store / Play / Stripe), never by clients.
create table if not exists subscriptions (
  user_id uuid references profiles(id) on delete cascade,
  provider text not null,
  provider_ref text not null,
  plan text not null,
  active boolean default true,
  expires_at timestamptz,
  primary key (provider, provider_ref)
);

-- ---------- row level security ----------
alter table profiles enable row level security;
alter table swipes enable row level security;
alter table matches enable row level security;
alter table messages enable row level security;
alter table reads enable row level security;
alter table blocks enable row level security;
alter table reports enable row level security;
alter table subscriptions enable row level security;

-- SECURITY DEFINER so it reads profiles without re-entering RLS (no recursion).
create or replace function my_bracket() returns age_bracket
language sql stable security definer set search_path = public as $$
  select bracket_for(birthdate) from profiles where id = auth.uid()
$$;

create or replace function is_blocked_either_way(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from blocks
    where (blocker_id = auth.uid() and blocked_id = other)
       or (blocker_id = other and blocked_id = auth.uid())
  )
$$;

create or replace function is_premium(uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select premium_until > now() from profiles where id = uid), false)
$$;

drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for all
  using (id = auth.uid()) with check (id = auth.uid());

-- You may read anyone in your own bracket who is not banned and not blocked.
drop policy if exists profiles_same_bracket on profiles;
create policy profiles_same_bracket on profiles for select using (
  bracket_for(birthdate) = my_bracket()
  and banned_at is null
  and not is_blocked_either_way(id)
);

drop policy if exists swipes_own on swipes;
create policy swipes_own on swipes for all
  using (swiper_id = auth.uid()) with check (swiper_id = auth.uid());

drop policy if exists matches_mine on matches;
create policy matches_mine on matches for select using (a = auth.uid() or b = auth.uid());

drop policy if exists messages_in_my_matches on messages;
create policy messages_in_my_matches on messages for select using (
  exists (select 1 from matches m where m.id = match_id and (m.a = auth.uid() or m.b = auth.uid()))
);

drop policy if exists reads_own on reads;
create policy reads_own on reads for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists blocks_own on blocks;
create policy blocks_own on blocks for all
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

drop policy if exists reports_insert on reports;
create policy reports_insert on reports for insert with check (reporter_id = auth.uid());

drop policy if exists subs_read on subscriptions;
create policy subs_read on subscriptions for select using (user_id = auth.uid());

-- ---------- RPCs ----------
-- Age verification is deliberately NOT callable by clients. The only writer of
-- profiles.verification is the `age-check` Edge Function, which runs with the
-- service role and records which provider made the decision. The old
-- complete_age_check() let any modified client mark itself checked, so it is
-- dropped here rather than left in place.
drop function if exists complete_age_check();

create or replace function my_gender() returns gender
language sql stable security definer set search_path = public as $$
  select gender from profiles where id = auth.uid()
$$;

create or replace function my_show_me() returns gender[]
language sql stable security definer set search_path = public as $$
  select coalesce(show_me, enum_range(null::gender)) from profiles where id = auth.uid()
$$;

-- Visibility is mutual: they must match who I want to see, and I must match who
-- they want to see. A profile with no gender set yet is shown to nobody, which
-- keeps half-finished signups out of the deck.
create or replace function discover_candidates(lim int default 20)
returns table (id uuid, display_name text, age int, emoji text, region text,
               bio text, interests text[], photo_url text, gender gender)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, years_old(p.birthdate), p.emoji, p.region,
         p.bio, p.interests, p.photo_url, p.gender
  from profiles p
  where p.id <> auth.uid()
    and bracket_for(p.birthdate) = my_bracket()
    and p.banned_at is null
    and p.verification in ('estimated', 'verified')
    and p.gender is not null
    and p.gender = any(my_show_me())
    and my_gender() = any(coalesce(p.show_me, enum_range(null::gender)))
    and not is_blocked_either_way(p.id)
    and not exists (select 1 from swipes s where s.swiper_id = auth.uid() and s.target_id = p.id)
  order by (exists (select 1 from swipes s
                    where s.swiper_id = p.id and s.target_id = auth.uid() and s.dir = 'like')) desc,
           random()
  limit lim
$$;

create or replace function likes_remaining() returns int
language sql stable security definer set search_path = public as $$
  select case when is_premium() then -1
    else greatest(0, 25 - (select count(*) from swipes
                           where swiper_id = auth.uid() and dir = 'like'
                             and created_at > now() - interval '24 hours'))::int end
$$;

create or replace function swipe(target uuid, direction swipe_dir) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); mid uuid; lo uuid; hi uuid;
begin
  if me is null or target = me then raise exception 'invalid target'; end if;
  if (select bracket_for(birthdate) from profiles where id = target) is distinct from my_bracket() then
    raise exception 'not in your age group';
  end if;
  if is_blocked_either_way(target) then raise exception 'blocked'; end if;
  -- Mutual gender preference, re-checked here so a modified client cannot like
  -- someone the deck would never have shown it.
  if direction = 'like' and not exists (
       select 1 from profiles p
       where p.id = target
         and p.gender = any(my_show_me())
         and my_gender() = any(coalesce(p.show_me, enum_range(null::gender)))
     ) then raise exception 'outside your preferences'; end if;
  if direction = 'like' and likes_remaining() = 0 then raise exception 'daily like limit reached'; end if;

  insert into swipes (swiper_id, target_id, dir) values (me, target, direction)
    on conflict (swiper_id, target_id) do update set dir = excluded.dir, created_at = now();

  if direction = 'like'
     and exists (select 1 from swipes where swiper_id = target and target_id = me and dir = 'like') then
    lo := least(me, target); hi := greatest(me, target);
    insert into matches (a, b) values (lo, hi)
      on conflict (a, b) do update set created_at = matches.created_at
      returning id into mid;
    return mid;
  end if;
  return null;
end $$;

create or replace function undo_swipe(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_premium() then raise exception 'premium required'; end if;
  delete from swipes where swiper_id = auth.uid() and target_id = target;
  delete from matches where a = least(auth.uid(), target) and b = greatest(auth.uid(), target);
end $$;

create or replace function who_liked_me()
returns table (id uuid, display_name text, age int, emoji text, region text,
               bio text, interests text[], photo_url text, gender gender)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, years_old(p.birthdate), p.emoji, p.region,
         p.bio, p.interests, p.photo_url, p.gender
  from swipes s join profiles p on p.id = s.swiper_id
  where s.target_id = auth.uid() and s.dir = 'like'
    and bracket_for(p.birthdate) = my_bracket()
    and p.banned_at is null
    and p.gender = any(my_show_me())
    and my_gender() = any(coalesce(p.show_me, enum_range(null::gender)))
    and not is_blocked_either_way(p.id)
    and not exists (select 1 from swipes x where x.swiper_id = auth.uid() and x.target_id = p.id)
$$;

create or replace function my_matches()
returns table (match_id uuid, other_id uuid, created_at timestamptz, display_name text,
               age int, emoji text, region text, bio text, interests text[], photo_url text,
               last_text text, last_at timestamptz, last_from text, unread int)
language sql stable security definer set search_path = public as $$
  select m.id, p.id, m.created_at, p.display_name, years_old(p.birthdate), p.emoji,
         p.region, p.bio, p.interests, p.photo_url,
         lm.body, lm.created_at,
         case when lm.sender_id = auth.uid() then 'me' else 'them' end,
         (select count(*) from messages x
          where x.match_id = m.id and x.sender_id <> auth.uid()
            and x.created_at > coalesce((select last_read_at from reads r
                                         where r.match_id = m.id and r.user_id = auth.uid()),
                                        'epoch'::timestamptz))::int
  from matches m
  join profiles p on p.id = case when m.a = auth.uid() then m.b else m.a end
  left join lateral (select body, created_at, sender_id from messages
                     where match_id = m.id order by created_at desc limit 1) lm on true
  where (m.a = auth.uid() or m.b = auth.uid())
    and not is_blocked_either_way(p.id)
    and p.banned_at is null
  order by coalesce(lm.created_at, m.created_at) desc
$$;

-- Off-platform detection, mirrored from safety.js. Strict for any chat with a minor.
create or replace function message_violation(body text) returns text
language sql immutable as $$
  select case
    when body ~ '(\+?\d[\d\s().-]{7,}\d)' then 'phone numbers'
    when body ~* '(^|\s)@[a-z0-9_.]{3,}' then 'social handles'
    when body ~* '\m(snap(chat)?|insta(gram)?|ig|tiktok|kik|discord|telegram|whatsapp|wickr|omegle)\M' then 'other apps'
    when body ~* '(https?://|www\.|\.com\M|\.gg\M|\.me\M)' then 'links'
    when body ~* '\m(my address|come over|meet (me )?(up|irl|in person)|where do you live|home alone|send (me )?(a )?(pic|pics|nudes?))\M' then 'unsafe requests'
    else null end
$$;

create or replace function send_message(mid uuid, body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); other uuid; v text; strict_mode boolean; new_id uuid;
begin
  select case when a = me then b else a end into other
  from matches where id = mid and (a = me or b = me);
  if other is null then raise exception 'not your match'; end if;
  if is_blocked_either_way(other) then raise exception 'blocked'; end if;

  strict_mode := (select bracket_for(birthdate) in ('13-15', '16-17') from profiles where id = me)
              or (select bracket_for(birthdate) in ('13-15', '16-17') from profiles where id = other);
  v := message_violation(body);
  if strict_mode and v is not null then raise exception 'blocked: %', v; end if;

  insert into messages (match_id, sender_id, body) values (mid, me, body) returning id into new_id;
  return new_id;
end $$;

create or replace function mark_read(mid uuid) returns void
language sql security definer set search_path = public as $$
  insert into reads (match_id, user_id, last_read_at) values (mid, auth.uid(), now())
  on conflict (match_id, user_id) do update set last_read_at = now()
$$;

create or replace function total_unread() returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(unread), 0)::int from my_matches()
$$;

create or replace function my_blocked()
returns table (id uuid, display_name text, age int, emoji text, region text,
               bio text, interests text[], photo_url text)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, years_old(p.birthdate), p.emoji, p.region,
         p.bio, p.interests, p.photo_url
  from blocks b join profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid()
$$;

create or replace function delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  delete from auth.users where id = auth.uid();
end $$;

-- Three open reports auto-hide an account pending human review.
create or replace function reports_autoban() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from reports where reported_id = new.reported_id and status = 'open') >= 3 then
    update profiles set banned_at = now() where id = new.reported_id and banned_at is null;
  end if;
  return new;
end $$;
drop trigger if exists reports_autoban_trg on reports;
create trigger reports_autoban_trg after insert on reports
  for each row execute function reports_autoban();

-- Realtime for chat. Guarded so re-running the file does not error.
do $$ begin
  alter publication supabase_realtime add table messages;
exception when duplicate_object then null; end $$;

-- ---------- what still needs a server before launch ----------
-- * Age verification is written only by the `age-check` Edge Function, which
--   runs with the service role. Set AGE_PROVIDER to a real vendor before
--   launch; the built-in 'demo' provider performs no identity check and is
--   recorded in profiles.verification_provider so you can tell them apart.
-- * Photo uploads should pass a nudity/CSAM classifier in an edge function
--   before photo_url is written. Never trust a client-supplied URL.
-- * premium_until must only be written by a payment webhook using the service
--   role key. The profiles trigger already blocks clients from setting it.
-- * Reports need a human review queue. The auto-hide above is a stopgap.
