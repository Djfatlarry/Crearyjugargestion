-- Tokens de Instagram y Facebook en una tabla cerrada (solo service_role), en vez de config,
-- que tiene una política abierta. Y registro de la publicación en la página de Facebook.
-- Aplicada en Supabase como migración "secretos_facebook".

create table if not exists public.instagram_secretos (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.instagram_secretos enable row level security;

alter table public.publicaciones_borrador add column if not exists fb_post_id text;
