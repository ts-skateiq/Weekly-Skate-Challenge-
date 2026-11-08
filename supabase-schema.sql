-- Run this in your new Supabase project's SQL editor

create table public.weekly_scores (
  id uuid default gen_random_uuid() primary key,
  client_id text not null,
  week_start date not null,
  name text not null,
  makes int not null,
  total int not null,
  dots text default '',
  created_at timestamptz default now(),
  unique(client_id, week_start)
);

-- Anyone can read and insert (no user accounts needed)
alter table public.weekly_scores enable row level security;

create policy "scores_read" on public.weekly_scores
  for select using (true);

create policy "scores_insert" on public.weekly_scores
  for insert with check (true);
