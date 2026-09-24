# Crear y Jugar — App de gestión · Deploy guide

## Estructura del proyecto

```
cyj-backend/
├── server.js           → API Express + SQLite
├── package.json
├── railway.toml        → Config de Railway
├── .gitignore
├── index_template.html → Frontend de la app (deployar en Netlify)
└── README.md
```

---

## Paso 1 — Subir el backend a GitHub

1. Andá a **github.com** → "New repository"
2. Nombre: `cyj-gestion-backend` → Create
3. En el repo vacío, hacé clic en **"uploading an existing file"**
4. Subí estos 4 archivos: `server.js`, `package.json`, `railway.toml`, `.gitignore`
5. Commit changes

---

## Paso 2 — Deployar en Railway

1. Andá a **railway.app** → tu proyecto vacío (o creá uno nuevo)
2. "Add a service" → "GitHub Repo" → seleccioná `cyj-gestion-backend`
3. Railway detecta Node.js automáticamente y deploya
4. Esperás ~2 minutos a que diga "Deployed"
5. En el servicio: **Settings → Networking → Generate Domain**
6. Copiá la URL (ej: `https://cyj-gestion-backend.railway.app`)

> **Importante:** no necesitás agregar variables de entorno. La base de datos SQLite se crea automáticamente en `/data/cyj.db`.

---

## Paso 3 — Deployar el frontend en Netlify

1. Renombrá `index_template.html` a `index.html`
2. Andá a **netlify.com** → "Add new site" → "Deploy manually"
3. Arrastrá el archivo `index.html`
4. Netlify te da una URL pública (ej: `https://cyj-gestion.netlify.app`)
5. Podés personalizar el nombre del sitio en Site Settings

---

## Paso 4 — Conectar frontend con backend

1. Abrí la app en el navegador (URL de Netlify)
2. Andá a la pestaña **Config**
3. En "Conexión al servidor", pegá la URL de Railway
4. Click "Conectar" → si aparece "✓ Conectado correctamente", listo
5. La primera vez importa automáticamente los datos históricos (Marzo–Mayo 2026)

---

## Usar en el celular / tablet del local

- Abrí la URL de Netlify en el navegador del celular
- En Chrome/Safari: menú → "Agregar a pantalla de inicio"
- La app se instala como ícono propio, abre sin barra del navegador
- Todos los dispositivos comparten los mismos datos en tiempo real

---

## Funcionamiento offline

Si no hay internet, la app guarda las ventas en `localStorage` del dispositivo. La próxima vez que haya conexión, las ventas locales se sincronizan automáticamente.

---

## Base de datos

SQLite en Railway — ubicada en `/data/cyj.db`. Las tablas son:

| Tabla | Contenido |
|---|---|
| `ventas` | Todas las ventas (históricas + nuevas) |
| `gastos` | Gastos históricos y manuales |
| `config` | Configuración de la app (costos fijos, impuestos, etc.) |
| `catalogo_custom` | Precios de venta personalizados por producto |
| `precio_log` | Historial de cambios de precio |

---

## Agente de Instagram

Genera publicaciones (borradores) a partir de los productos de `proveedores`. Código en `instagram-agente.js` (flujo y rutas) e `instagram-render.js` (plantillas 1080x1350 con Satori + resvg, sin navegador). La tabla y el bucket están en `migrations/2026-09-23_instagram_agente.sql`.

**Variables de entorno**

| Variable | Para qué |
|---|---|
| `ANTHROPIC_API_KEY` | Textos de cada publicación |
| `SUPABASE_KEY` | Tiene que poder escribir en Storage (service role) |
| `IG_TEMA` | `panel` (default), `color` o `crema` |
| `IG_RECORTE` | `ninguno` (default) o `removebg` + `REMOVEBG_API_KEY` |
| `IG_ACCESS_TOKEN` | Token de la cuenta profesional de Instagram (API con inicio de sesión de Instagram, empieza con `IG`). Se renueva solo cada semana y el ID de la cuenta se averigua solo. Con un token de Facebook (`EAA…`) hace falta además `IG_USER_ID` |
| `IG_ADMIN_KEY` | Clave que piden generar, editar, borrar y publicar (header `x-admin-key`) |

El logo va en `assets/logo-crear-y-jugar.png`.

**Agenda:** por defecto publica martes y jueves 21:00 y sábado 10:00 (hora Argentina), y los domingos 20:00 arma solo los borradores de la semana. Cada borrador tiene `programado_para`; con Instagram conectado, los aprobados se publican solos a esa hora (el servidor revisa cada 5 minutos; `IG_AGENDA=off` lo desactiva).

**Pantalla de revisión:** `instagram.html`. Se sube a Netlify en la misma carpeta que la app y queda en `/instagram.html`. Toma la URL del backend que ya está configurada en la app; la clave de admin se carga una vez en "Conexión".

**Rutas**

- `GET /instagram/candidatos?n=10` — próximos productos según la rotación
- `POST /instagram/generar` — `{ "tipo"?: "unico" | "institucional", "producto_id"?: "...", "tema"?: "panel", "plantilla_id"?: "...", "idea"?: "..." }` genera un carrusel de un producto y lo guarda como borrador
- `GET /instagram/borradores?estado=borrador` — lista
- `GET /instagram/borradores/:id`
- `PATCH /instagram/borradores/:id` — `{ "caption"?: "...", "estado"?: "aprobado" | "borrador" }`
- `DELETE /instagram/borradores/:id`
- `POST /instagram/borradores/:id/editar` — `{ "mensaje": "..." }` chat libre con Claude sobre el diseño (ve las slides y edita su HTML)
- `POST /instagram/borradores/:id/deshacer` — vuelve a la versión anterior
- `POST /instagram/borradores/:id/guardar-plantilla` — `{ "nombre": "..." }` guarda el diseño como plantilla reutilizable
- `GET /instagram/plantillas`, `DELETE /instagram/plantillas/:id`
- `POST /instagram/borradores/:id/marcar-publicado` — para cuando se sube a mano desde el celular
- `GET /instagram/conexion` — prueba la conexión con Instagram y devuelve el usuario conectado
- `GET /instagram/agenda`, `PUT /instagram/agenda` — días/horarios de publicación y generación automática (se guarda en `config`, clave `instagram_agenda`)
- `POST /instagram/agenda/generar-semana` — arma los borradores que faltan para los próximos 7 días
- `POST /instagram/borradores/:id/publicar` — publica un borrador aprobado (requiere las variables de Instagram)
