# Estudio Crear y Jugar

App instalable (ícono en la PC y en el celular) para que María Elena, Carlos y Pablo creen y aprueben las publicaciones de Instagram conversando con un asistente.

## Cómo publicarla

1. En Netlify: **Add new site → Deploy manually** y arrastrar **esta carpeta `estudio` entera** (no un archivo suelto). Es un sitio nuevo: no pisa la app de gestión.
2. Abrir la dirección que da Netlify, elegir la persona y escribir la clave (la misma `IG_ADMIN_KEY` del agente de Instagram).
3. El servidor por defecto es `https://crearyjugargestion.onrender.com`; se cambia en "Opciones avanzadas".

## Instalar el ícono

- **iPhone:** abrir el sitio en Safari → botón Compartir → "Agregar a pantalla de inicio".
- **Android / PC con Chrome:** menú del navegador → "Instalar app".

## Qué hace (etapa 1, primera tanda)

- Saludo del día con lo que toca según el calendario y lo que espera aprobación.
- Menú de bloques: publicación del día, de la semana, reels (guion y lista de tomas), video institucional, ideas, pendientes.
- Tarjetas con Aprobar / Pedir cambios / Descartar. Al aprobar, si no tiene fecha, la agenda en el próximo horario libre del agente.
- El backend está en `estudio.js` (rutas `/estudio/*`) y usa las rutas del agente de Instagram por dentro.

Pendiente para la segunda tanda: notificaciones al celular y saludo programado a las 10:00.
