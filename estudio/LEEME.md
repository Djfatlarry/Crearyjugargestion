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
- Dos pestañas: **Crear** (saludo y bloques) y **Para aprobar** (publicaciones pendientes y ya programadas).
- Cada bloque abre su propio proceso con su charla aparte (publicación del día, de la semana, reels, video institucional, ideas, charla libre). La del día empieza de cero cada día.
- Lo que se arma en una charla queda en Para aprobar, con Aprobar / Pedir cambios / Descartar. Al aprobar, si no tiene fecha, se agenda en el próximo horario libre del agente.
- Colores: cada publicación nueva usa una combinación de fondos distinta de las últimas (6 temas para un producto, 4 portadas para varios productos, 4 paletas para institucionales).
- El backend está en `estudio.js` (rutas `/estudio/*`) y usa las rutas del agente de Instagram por dentro.

Pendiente para la segunda tanda: notificaciones al celular y saludo programado a las 10:00.
