-- Calendarización de publicaciones: fecha y hora en que se publica cada borrador aprobado.
-- La agenda (días/horarios y generación automática) se guarda en config, clave 'instagram_agenda'.
-- Aplicada en Supabase como migración "instagram_agenda".

alter table public.publicaciones_borrador add column if not exists programado_para timestamptz;
create index if not exists publicaciones_borrador_programado_idx on public.publicaciones_borrador (programado_para) where programado_para is not null;
