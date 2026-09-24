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
-- Age visibility is a sliding window, not fixed buckets. Under 18 you can
-- never see past 18; from 18 up you can never see below 17. Those clamps meet
-- in exactly one place, so 17 and 18 can see each other and no other
-- minor/adult pair can. Pure integer maths, so these are IMMUTABLE and usable
-- inside row level security policies.
create or replace function visible_lo(a int) returns int language sql immutable as $$
  select case when a < 18 then greatest(13, a - 2) else greatest(17, a - 2) end
$$;
create or replace function visible_hi(a int) returns int language sql immutable as $$
  select case when a < 18 then least(18, a + 2) else least(25, a + 2) end
$$;
-- Visibility is mutual: each has to fall inside the other's window.
create or replace function can_see(viewer_age int, target_age int) returns boolean
language sql immutable as $$
  select viewer_age between 13 and 25 and target_age between 13 and 25
     and target_age between visible_lo(viewer_age) and visible_hi(viewer_age)
     and viewer_age between visible_lo(target_age) and visible_hi(target_age)
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
alter table profiles add column if not exists premium_tier text check (premium_tier in ('plus', 'max'));
alter table profiles add column if not exists photo_status text not null default 'none' check (photo_status in ('none', 'pending', 'approved', 'rejected'));

-- The face age check runs on the person's own device before they can sign up
-- (agecheck.js); no image ever reaches the server. The result, an estimated
-- age, is attached to the account as auth user metadata at signup. This reads
-- it back. SECURITY DEFINER because the app's role cannot read auth.users,
-- and it only ever returns the caller's own value.
drop function if exists signup_age_check(uuid);
create or replace function signup_age_check() returns jsonb
language sql stable security definer set search_path = public as $$
  select raw_user_meta_data -> 'age_check' from auth.users where id = auth.uid()
$$;

-- How far a claimed age may sit from the face estimate. Wide on purpose: face
-- models are off by several years for teenagers, and a false rejection locks a
-- real teenager out. Keep in step with AGE_CHECK in safety.js.
create or replace function age_check_fits(claimed int, estimate numeric) returns boolean
language sql immutable as $$
  select claimed >= estimate - 10 and claimed <= estimate + 8
$$;

-- Minimum age is enforced in a trigger, because a CHECK constraint may only
-- call IMMUTABLE functions and age depends on the current date.
-- client_write distinguishes a direct request from the app (which runs as the
-- "authenticated" role) from a SECURITY DEFINER function or the service role
-- key (which run as the owner). Trusted server code must stay able to grant
-- verification and premium, so only client writes get those fields locked.
create or replace function profiles_guard() returns trigger language plpgsql as $$
declare
  client_write boolean := current_user in ('authenticated', 'anon');
  ac jsonb;
  est numeric;
begin
  if years_old(new.birthdate) < 13 then
    raise exception 'must be at least 13 years old';
  end if;
  if years_old(new.birthdate) > 25 then
    raise exception 'Hooky is for 13 to 25 year olds';
  end if;
  if tg_op = 'UPDATE' then
    -- Birthdate is write-once. Nobody ages themselves into another group.
    if new.birthdate is distinct from old.birthdate then
      raise exception 'birthdate cannot be changed';
    end if;
    if client_write then
      -- Only trusted server code may set these. photo_url in particular: if a
      -- client could write it, it would skip photo moderation entirely.
      new.verification := old.verification;
      new.premium_until := old.premium_until;
      new.premium_tier := old.premium_tier;
      new.banned_at := old.banned_at;
      new.photo_url := old.photo_url;
      new.photo_status := old.photo_status;
      new.verification_provider := old.verification_provider;
      new.verified_at := old.verified_at;
      new.age_estimate_low := old.age_estimate_low;
      new.age_estimate_high := old.age_estimate_high;
    end if;
  -- An upsert of an existing profile fires this INSERT branch too, before the
  -- conflict turns it into an UPDATE (which the branch above then guards), so
  -- the new-profile rules only apply when the row really is new.
  elsif client_write and not exists (select 1 from profiles p where p.id = new.id) then
    new.premium_until := null;
    new.premium_tier := null;
    new.banned_at := null;
    new.photo_url := null;
    new.photo_status := 'none';
    -- A profile can only be created after the on-device age check, and the
    -- birthday has to be consistent with what the camera saw.
    ac := case when new.id = auth.uid() then signup_age_check() end;
    begin
      est := (ac ->> 'estimate')::numeric;
    exception when others then est := null;
    end;
    if est is null or est < 1 or est > 100 then
      raise exception 'age check required';
    end if;
    if not age_check_fits(years_old(new.birthdate), est) then
      raise exception 'birthday does not match age check';
    end if;
    new.verification := 'estimated';
    new.verification_provider := 'on-device';
    new.verified_at := now();
    new.age_estimate_low := floor(est - 3);
    new.age_estimate_high := ceil(est + 3);
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

-- Private rooms. A room is pinned to the age window of whoever created it, so
-- it can never become a way to reach outside your own window.
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references profiles(id) on delete cascade,
  topic text not null check (char_length(topic) between 3 and 60),
  age_lo int not null,
  age_hi int not null,
  created_at timestamptz default now(),
  closed_at timestamptz
);
create index if not exists rooms_open on rooms(created_at) where closed_at is null;

create table if not exists room_members (
  room_id uuid references rooms(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (room_id, user_id)
);

create table if not exists room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references rooms(id) on delete cascade,
  sender_id uuid references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz default now()
);
create index if not exists room_messages_room on room_messages(room_id, created_at);

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

-- Idempotency for the billing webhook. Payment providers retry, so the same
-- event can arrive more than once and must not be credited twice.
create table if not exists billing_events (
  provider text not null,
  event_id text not null,
  user_id uuid references profiles(id) on delete cascade,
  processed_at timestamptz default now(),
  primary key (provider, event_id)
);

-- Web Push subscriptions. One row per browser or installed app, so a person
-- with a phone and a laptop gets notified on both.
create table if not exists push_subscriptions (
  endpoint text primary key,
  user_id uuid references profiles(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);
create index if not exists push_subs_user on push_subscriptions(user_id);

-- ---------- row level security ----------
alter table profiles enable row level security;
alter table swipes enable row level security;
alter table matches enable row level security;
alter table messages enable row level security;
alter table reads enable row level security;
alter table blocks enable row level security;
alter table reports enable row level security;
alter table subscriptions enable row level security;
alter table billing_events enable row level security;
alter table push_subscriptions enable row level security;
alter table rooms enable row level security;
alter table room_members enable row level security;
alter table room_messages enable row level security;

-- SECURITY DEFINER so it reads profiles without re-entering RLS (no recursion).
create or replace function my_age() returns int
language sql stable security definer set search_path = public as $$
  select years_old(birthdate) from profiles where id = auth.uid()
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
  can_see(my_age(), years_old(birthdate))
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

drop policy if exists push_subs_own on push_subscriptions;
create policy push_subs_own on push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists reports_insert on reports;
create policy reports_insert on reports for insert with check (reporter_id = auth.uid());

drop policy if exists subs_read on subscriptions;
create policy subs_read on subscriptions for select using (user_id = auth.uid());

-- Rooms are visible to anyone whose age fits the room, and to its members.
drop policy if exists rooms_visible on rooms;
create policy rooms_visible on rooms for select using (
  closed_at is null and my_age() between age_lo and age_hi
);
drop policy if exists room_members_read on room_members;
create policy room_members_read on room_members for select using (
  exists (select 1 from room_members m where m.room_id = room_id and m.user_id = auth.uid())
);
drop policy if exists room_messages_read on room_messages;
create policy room_messages_read on room_messages for select using (
  exists (select 1 from room_members m where m.room_id = room_messages.room_id and m.user_id = auth.uid())
);

-- ---------- RPCs ----------
-- There is no RPC that sets verification. Clients get 'estimated' only by
-- creating their profile after the on-device age check (see profiles_guard),
-- and the server-side `age-check` Edge Function can still overwrite it with a
-- stronger verdict. The old complete_age_check() let any modified client mark
-- itself checked at any time, so it is dropped here rather than left in place.
drop function if exists complete_age_check();

-- For accounts made before the signup age check existed: after the person
-- runs the on-device check, this applies its result to their existing
-- profile, under the same birthday rule profiles_guard uses for new ones. It
-- never downgrades a profile that is already checked.
create or replace function claim_age_check() returns verification_state
language plpgsql security definer set search_path = public as $$
declare ac jsonb := signup_age_check(); est numeric; cur verification_state; bd date;
begin
  select verification, birthdate into cur, bd from profiles where id = auth.uid();
  if not found then raise exception 'no profile'; end if;
  if cur in ('estimated', 'verified') then return cur; end if;
  begin
    est := (ac ->> 'estimate')::numeric;
  exception when others then est := null;
  end;
  if est is null or est < 1 or est > 100 then raise exception 'age check required'; end if;
  if not age_check_fits(years_old(bd), est) then raise exception 'birthday does not match age check'; end if;
  update profiles set verification = 'estimated', verification_provider = 'on-device', verified_at = now(),
    age_estimate_low = floor(est - 3), age_estimate_high = ceil(est + 3)
  where id = auth.uid();
  return 'estimated';
end $$;

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
-- Dropped first: the return type gained a gender column, and CREATE OR REPLACE
-- cannot change a function's output columns.
drop function if exists discover_candidates(int);
create or replace function discover_candidates(lim int default 20)
returns table (id uuid, display_name text, age int, emoji text, region text,
               bio text, interests text[], photo_url text, gender gender)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, years_old(p.birthdate), p.emoji, p.region,
         p.bio, p.interests, p.photo_url, p.gender
  from profiles p
  where p.id <> auth.uid()
    and can_see(my_age(), years_old(p.birthdate))
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
  if not can_see(my_age(), (select years_old(birthdate) from profiles where id = target)) then
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

drop function if exists who_liked_me();
create or replace function who_liked_me()
returns table (id uuid, display_name text, age int, emoji text, region text,
               bio text, interests text[], photo_url text, gender gender)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, years_old(p.birthdate), p.emoji, p.region,
         p.bio, p.interests, p.photo_url, p.gender
  from swipes s join profiles p on p.id = s.swiper_id
  where s.target_id = auth.uid() and s.dir = 'like'
    and can_see(my_age(), years_old(p.birthdate))
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

  strict_mode := (select years_old(birthdate) < 18 from profiles where id = me)
              or (select years_old(birthdate) < 18 from profiles where id = other);
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
-- * The signup age check runs on the person's device by product decision, so
--   no image ever leaves the phone. The cost: its result is attested by the
--   client, and a modified app could lie about it. Such profiles are recorded
--   with verification_provider = 'on-device'; the server-side `age-check`
--   function or an ID provider can overwrite that with a stronger verdict.
-- * Photo uploads should pass a nudity/CSAM classifier in an edge function
--   before photo_url is written. Never trust a client-supplied URL.
-- * premium_until must only be written by a payment webhook using the service
--   role key. The profiles trigger already blocks clients from setting it.
-- * Reports need a human review queue. The auto-hide above is a stopgap.

-- ---------- private rooms ----------
-- Room limits come from the tier, so the client cannot grant itself rooms.
create or replace function rooms_allowed() returns int
language sql stable security definer set search_path = public as $$
  select case
    when not is_premium() then 0
    when (select premium_tier from profiles where id = auth.uid()) = 'max' then 5
    else 1 end
$$;

create or replace function create_room(topic text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a int; rid uuid; used int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if rooms_allowed() = 0 then raise exception 'rooms need Hooky+'; end if;
  select count(*) into used from rooms where owner_id = me and closed_at is null;
  if used >= rooms_allowed() then raise exception 'you have used all your rooms'; end if;
  if char_length(trim(topic)) < 3 then raise exception 'give the room a topic'; end if;
  -- A topic is public text, so it gets the same filtering a message would.
  if message_violation(topic) is not null then raise exception 'that topic is not allowed here'; end if;

  a := my_age();
  insert into rooms (owner_id, topic, age_lo, age_hi)
  values (me, trim(topic), visible_lo(a), visible_hi(a))
  returning id into rid;
  insert into room_members (room_id, user_id) values (rid, me);
  return rid;
end $$;

create or replace function close_room(rid uuid) returns void
language sql security definer set search_path = public as $$
  update rooms set closed_at = now() where id = rid and owner_id = auth.uid()
$$;

create or replace function join_room(rid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a int := my_age(); lo int; hi int; owner uuid;
begin
  select age_lo, age_hi, owner_id into lo, hi, owner from rooms where id = rid and closed_at is null;
  if lo is null then raise exception 'room not found'; end if;
  if a < lo or a > hi then raise exception 'that room is not for your age group'; end if;
  if is_blocked_either_way(owner) then raise exception 'blocked'; end if;
  insert into room_members (room_id, user_id) values (rid, auth.uid()) on conflict do nothing;
end $$;

create or replace function leave_room(rid uuid) returns void
language sql security definer set search_path = public as $$
  delete from room_members where room_id = rid and user_id = auth.uid()
$$;

-- Rooms you can see: open, age-appropriate, and not run by someone you blocked.
create or replace function browse_rooms(lim int default 30)
returns table (id uuid, topic text, owner_id uuid, owner_name text, age_lo int, age_hi int,
               members int, joined boolean, mine boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, r.topic, r.owner_id, p.display_name, r.age_lo, r.age_hi,
         (select count(*) from room_members m where m.room_id = r.id)::int,
         exists (select 1 from room_members m where m.room_id = r.id and m.user_id = auth.uid()),
         r.owner_id = auth.uid(),
         r.created_at
  from rooms r join profiles p on p.id = r.owner_id
  where r.closed_at is null
    and my_age() between r.age_lo and r.age_hi
    and p.banned_at is null
    and not is_blocked_either_way(r.owner_id)
  order by r.created_at desc
  limit lim
$$;

create or replace function room_messages_list(rid uuid, lim int default 100)
returns table (id uuid, sender_id uuid, sender_name text, body text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.sender_id, p.display_name, m.body, m.created_at
  from room_messages m join profiles p on p.id = m.sender_id
  where m.room_id = rid
    and exists (select 1 from room_members x where x.room_id = rid and x.user_id = auth.uid())
  order by m.created_at
  limit lim
$$;

-- A room whose window reaches below 18 is filtered as strictly as a teen chat.
create or replace function room_send(rid uuid, body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); lo int; v text; new_id uuid;
begin
  select age_lo into lo from rooms where id = rid and closed_at is null;
  if lo is null then raise exception 'room not found'; end if;
  if not exists (select 1 from room_members m where m.room_id = rid and m.user_id = me) then
    raise exception 'join the room first';
  end if;
  v := message_violation(body);
  if (lo < 18 or my_age() < 18) and v is not null then raise exception 'blocked: %', v; end if;
  insert into room_messages (room_id, sender_id, body) values (rid, me, body) returning id into new_id;
  return new_id;
end $$;

do $$ begin
  alter publication supabase_realtime add table room_messages;
exception when duplicate_object then null; end $$;

-- ---------- hardening ----------
-- Leftovers from the old fixed-bracket design.
drop function if exists my_bracket();
drop function if exists bracket_for(date);

-- Pin search_path on the helpers so a caller cannot shadow what they call.
alter function years_old(date) set search_path = public;
alter function visible_lo(int) set search_path = public;
alter function visible_hi(int) set search_path = public;
alter function can_see(int, int) set search_path = public;
alter function message_violation(text) set search_path = public;
alter function age_check_fits(int, numeric) set search_path = public;
alter function profiles_guard() set search_path = public;

-- Every SECURITY DEFINER function is for signed-in people only. Signed-out
-- callers (anon) get nothing, and trigger functions are callable by no one.
-- rls_auto_enable is Supabase's own event trigger and is left alone.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig, p.prorettype = 'trigger'::regtype as is_trigger
           from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname <> 'rls_auto_enable' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.is_trigger then
      execute format('revoke execute on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;
