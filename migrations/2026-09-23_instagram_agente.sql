-- Agente de Instagram: borradores de publicaciones + bucket público para las imágenes.
-- Aplicada en Supabase como migración "instagram_agente".

create table if not exists public.publicaciones_borrador (
  id uuid primary key default gen_random_uuid(),
  tipo text not null,                          -- 'unico' (carrusel de un producto); después 'carrusel', 'institucional', ...
  tema text,                                   -- 'panel' | 'color' | 'crema'
  producto_ids text[] not null default '{}',   -- ids de proveedores usados (sirve para la rotación)
  contenido jsonb,                             -- lo que generó Claude (gancho, frase, edad, habilidades, ...)
  caption text,                                -- texto del posteo con hashtags (editable antes de aprobar)
  slides jsonb not null default '[]',          -- URLs públicas de las imágenes, en orden
  estado text not null default 'borrador' check (estado in ('borrador', 'aprobado', 'publicado')),
  ig_media_id text,                            -- id del posteo en Instagram, una vez publicado
  error text,                                  -- último error al publicar, si hubo
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  publicado_at timestamptz
);

create index if not exists publicaciones_borrador_estado_idx on public.publicaciones_borrador (estado, created_at desc);

-- Solo el backend (service_role) accede: RLS activo y sin políticas públicas.
alter table public.publicaciones_borrador enable row level security;

-- Bucket público para slides renderizadas y fotos recortadas (lo lee Instagram al publicar).
insert into storage.buckets (id, name, public)
values ('instagram', 'instagram', true)
on conflict (id) do nothing;
