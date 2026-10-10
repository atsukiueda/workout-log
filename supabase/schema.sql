-- 筋トレ記録アプリ用のテーブル定義
-- Supabase ダッシュボードの「SQL Editor」に貼り付けて「Run」で実行してください。
-- Row Level Security により、各ユーザーは自分の行だけを読み書きできます。

-- 日ごとのトレーニング記録（1日1行。種目とセットは entries に JSON で保存）
create table if not exists public.workout_sessions (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  date       date        not null,
  entries    jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

-- プロフィール・設定（1ユーザー1行）
create table if not exists public.user_settings (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  settings   jsonb       not null,
  updated_at timestamptz not null default now()
);

alter table public.workout_sessions enable row level security;
alter table public.user_settings    enable row level security;

drop policy if exists "own sessions" on public.workout_sessions;
create policy "own sessions" on public.workout_sessions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
