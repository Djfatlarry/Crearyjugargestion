-- Plantillas de Instagram creadas desde el chat: HTML de cada slide con marcadores
-- ({{nombre}}, {{foto_principal}}, ...) que se completan con los datos de cada producto.
-- Aplicada en Supabase como migración "plantillas_instagram".

create table if not exists public.plantillas_instagram (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  slides jsonb not null,                                   -- HTML de cada slide, en orden
  creado_desde uuid references public.publicaciones_borrador(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Solo el backend (service_role) accede.
alter table public.plantillas_instagram enable row level security;
