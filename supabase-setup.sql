-- Home Organizer cloud sync schema
-- Run this in the Supabase SQL Editor after creating a project.
-- The app uses Google OAuth through Supabase Auth.

create table if not exists public.home_organizer_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.home_organizer_backups (
  user_id uuid not null references auth.users(id) on delete cascade,
  backup_date date not null default (timezone('utc', now())::date),
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, backup_date)
);

alter table public.home_organizer_data enable row level security;
alter table public.home_organizer_backups enable row level security;

drop policy if exists "Users manage their own organizer data" on public.home_organizer_data;
create policy "Users manage their own organizer data"
on public.home_organizer_data for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users manage their own organizer backups" on public.home_organizer_backups;
create policy "Users manage their own organizer backups"
on public.home_organizer_backups for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('home-organizer-photos', 'home-organizer-photos', false, 12582912, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = false, file_size_limit = 12582912;

drop policy if exists "Users access their own organizer photos" on storage.objects;
create policy "Users access their own organizer photos"
on storage.objects for all
to authenticated
using (bucket_id = 'home-organizer-photos' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'home-organizer-photos' and (storage.foldername(name))[1] = auth.uid()::text);
