-- ============================================================
--  Nova — Supabase Schema
--  Supabase dashboard > SQL Editor > New query > මේ සම්පූර්ණ file එක paste කරලා Run කරන්න.
-- ============================================================

create table if not exists conversations (
  id uuid primary key,
  session_id text not null,
  title text not null default 'සංවාදය',
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null default '',
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversations_session on conversations(session_id);
create index if not exists idx_messages_conv on messages(conversation_id);

-- Row Level Security: app එකට auth (login) නැති නිසා, anon key එකෙන්ම
-- read/write කරන්න පුළුවන් විදිහට policy දානවා. (session_id column එක browser
-- එකේ localStorage එකේ තියෙන id එකක් විතරයි — ඒක සැඟවිලා තියෙන්නේ නෑ, ඒ නිසා
-- මේක "private" data protection එකක් නොවෙයි, "personal-use convenience" එකක් විතරයි.)

alter table conversations enable row level security;
alter table messages enable row level security;

create policy "allow all conversations" on conversations
  for all using (true) with check (true);

create policy "allow all messages" on messages
  for all using (true) with check (true);

