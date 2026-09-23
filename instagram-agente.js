// instagram-agente.js
//
// Agente que arma publicaciones de Instagram para Crear y Jugar:
//   1. elige productos (con foto y stock, rotando los que hace más que no aparecen)
//   2. recorta el fondo de la foto (paso intercambiable, con caché en Storage)
//   3. le pide a Claude los textos (frase pedagógica, edad, habilidades, caption)
//   4. renderiza las slides (instagram-render.js) y las sube a Supabase Storage
//   5. guarda todo como borrador en publicaciones_borrador (borrador -> aprobado -> publicado)
//   6. publica en Instagram Graph API (preparado; se activa con IG_USER_ID + IG_ACCESS_TOKEN)
//
// Integración en server.js (ya hecha):
//   const registrarInstagramAgente = require('./instagram-agente');
//   registrarInstagramAgente(app, sb, llamarClaude);
//
// Variables de entorno:
//   SUPABASE_URL, SUPABASE_KEY   (las mismas del backend; la key tiene que poder escribir en Storage)
//   ANTHROPIC_API_KEY            (la usa llamarClaude en server.js)
//   IG_BUCKET                    bucket público de Storage (default 'instagram')
//   IG_TEMA                      tema de color por defecto: 'panel' | 'color' | 'crema' (default 'panel')
//   IG_RECORTE                   'ninguno' (default) | 'removebg'
//   REMOVEBG_API_KEY             si IG_RECORTE=removebg
//   IG_USER_ID, IG_ACCESS_TOKEN  cuenta profesional de Instagram + token (para publicar)
//   IG_GRAPH_VERSION             default 'v21.0'

const crypto = require('crypto');
const sharp = require('sharp');
const { renderizar } = require('./instagram-render');

const BUCKET = process.env.IG_BUCKET || 'instagram';
const TEMA = process.env.IG_TEMA || 'panel';
const GRAPH = `https://graph.facebook.com/${process.env.IG_GRAPH_VERSION || 'v21.0'}`;

// --- Utilidades ---

function imagenesDe(p) {
  const imgs = Array.isArray(p.imagenes) ? p.imagenes : [];
  return imgs.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
}

async function bajar(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo bajar ${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// --- Supabase Storage ---

function urlPublica(ruta) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${ruta}`;
}

async function subirArchivo(ruta, buffer, contentType) {
  const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${ruta}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!r.ok) throw new Error(`Storage: no se pudo subir ${ruta}: ${r.status} ${await r.text()}`);
  return urlPublica(ruta);
}

async function existeArchivo(ruta) {
  const r = await fetch(urlPublica(ruta), { method: 'HEAD' });
  return r.ok;
}

// --- 1. Selector de productos ---
//
// Elegibles: stock > 0 y al menos una foto. Orden: primero los que nunca aparecieron en una
// publicación; después los que hace más tiempo que no aparecen. Empates, al azar.

async function candidatos(sb) {
  const [productos, pubs] = await Promise.all([
    sb('GET', 'proveedores', {
      select: 'id,nombre,descripcion,categoria,categoria_grande,proveedor,stock,imagenes',
      filter: 'stock=gt.0&imagenes=not.is.null',
    }),
    sb('GET', 'publicaciones_borrador', { select: 'producto_ids,created_at' }),
  ]);

  const ultimaVez = new Map();
  for (const pub of pubs || []) {
    const t = new Date(pub.created_at).getTime();
    for (const id of pub.producto_ids || []) {
      if (!ultimaVez.has(id) || ultimaVez.get(id) < t) ultimaVez.set(id, t);
    }
  }

  return (productos || [])
    .filter((p) => p.nombre && imagenesDe(p).length > 0)
    .map((p) => ({ ...p, ultima_publicacion: ultimaVez.has(p.id) ? new Date(ultimaVez.get(p.id)).toISOString() : null, _azar: Math.random() }))
    .sort((a, b) => (ultimaVez.get(a.id) || 0) - (ultimaVez.get(b.id) || 0) || a._azar - b._azar)
    .map(({ _azar, ...p }) => p);
}

// --- 2. Recorte de fondo (intercambiable) ---
//
// Cada recortador recibe el buffer de la foto y devuelve un PNG con fondo transparente (o null si
// no recorta). Para sumar otro (una API distinta o una librería local), agregarlo acá y elegirlo
// con IG_RECORTE.

const RECORTADORES = {
  ninguno: async () => null,

  removebg: async (buffer) => {
    if (!process.env.REMOVEBG_API_KEY) throw new Error('Falta REMOVEBG_API_KEY');
    const form = new FormData();
    form.append('image_file', new Blob([buffer]), 'foto');
    form.append('size', 'auto');
    const r = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': process.env.REMOVEBG_API_KEY },
      body: form,
    });
    if (!r.ok) throw new Error(`remove.bg: ${r.status} ${await r.text()}`);
    return Buffer.from(await r.arrayBuffer());
  },
};

// Devuelve la URL pública de la foto recortada, o null si no hay recorte.
// Guarda el resultado en Storage para no volver a procesar (ni pagar) la misma foto.
async function fotoRecortada(producto, urlFoto) {
  const metodo = process.env.IG_RECORTE || 'ninguno';
  const recortar = RECORTADORES[metodo];
  if (!recortar) throw new Error(`IG_RECORTE desconocido: ${metodo}`);
  if (metodo === 'ninguno') return null;

  const hash = crypto.createHash('sha1').update(urlFoto).digest('hex').slice(0, 12);
  const ruta = `recortes/${producto.id}/${metodo}-${hash}.png`;
  if (await existeArchivo(ruta)) return urlPublica(ruta);

  try {
    const recorte = await recortar(await bajar(urlFoto));
    if (!recorte) return null;
    // Saca el margen transparente para que el producto ocupe todo el espacio disponible
    const ajustado = await sharp(recorte).trim().png().toBuffer();
    return await subirArchivo(ruta, ajustado, 'image/png');
  } catch (e) {
    // Si el recorte falla, seguimos con la foto original (va en marco polaroid)
    console.error(`[instagram] recorte falló para ${producto.id}: ${e.message}`);
    return null;
  }
}

// --- 3. Textos con Claude ---

function promptProductoUnico(p) {
  return `Sos quien escribe las publicaciones de Instagram de "Crear y Jugar", una juguetería didáctica de Olivos (Buenos Aires). Escribís en español rioplatense (voseo), con tono cálido y pedagógico, pensando en madres, padres, docentes y quienes regalan.

Producto:
- Nombre: ${p.nombre}
- Descripción: ${p.descripcion || '(sin descripción)'}
- Categoría: ${p.categoria || p.categoria_grande || '(sin categoría)'}
- Marca/proveedor: ${p.proveedor || '(sin dato)'}

Reglas:
- NUNCA menciones precios, descuentos ni cuotas.
- No inventes contenidos, piezas, cantidades ni características que no surjan del nombre o la descripción. Si la información es poca, hablá de lo que ese tipo de juego propone y desarrolla en general.
- Sin emojis en los textos de las imágenes (gancho, frase, bajada, habilidades). En el caption podés usar pocos (2 o 3 como máximo).
- Frases cortas y concretas; nada de palabras rimbombantes.

Devolvé ÚNICAMENTE un JSON válido con esta forma:
{
  "nombre": "nombre corto y lindo para mostrar (máx. 22 caracteres, sin códigos ni medidas)",
  "gancho": "frase breve que invite a jugar, entre signos de exclamación (máx. 32 caracteres)",
  "edad": "edad recomendada con formato '+N años' o 'N a M años'",
  "frase": "frase pedagógica: qué desarrolla este juego (máx. 110 caracteres)",
  "bajada": "una oración que cuente qué es o cómo se juega (máx. 100 caracteres)",
  "habilidades": [
    { "nombre": "habilidad (1 a 3 palabras)", "detalle": "cómo la desarrolla este juego (máx. 70 caracteres)" }
  ],
  "caption": "texto del posteo: 2 o 3 párrafos cortos, cálido, que cierre invitando a visitar la tienda online (link en la bio) o el local en Ricardo Gutiérrez 1215, Olivos. Al final, en una línea aparte, entre 8 y 12 hashtags en español relevantes (incluí #CrearYJugar y #JuguetesDidacticos)."
}
Las habilidades tienen que ser exactamente 3.`;
}

function parsearJson(texto) {
  const ini = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (ini === -1 || fin === -1) throw new Error(`La IA no devolvió JSON: ${texto.slice(0, 200)}`);
  return JSON.parse(texto.slice(ini, fin + 1));
}

async function textosProducto(llamarClaude, producto) {
  const t = parsearJson(await llamarClaude(promptProductoUnico(producto), { maxTokens: 1500 }));
  if (!t.nombre) t.nombre = producto.nombre;
  t.habilidades = (t.habilidades || []).slice(0, 3);
  // Red de seguridad: si igual se coló un precio en el caption, no lo guardamos así
  if (/\$\s?\d|\bprecios?\b/i.test(t.caption || '')) throw new Error('El caption generado menciona precios; volvé a generar');
  return t;
}

// --- 4. Render + subida ---

// Instagram solo acepta JPEG para publicar: las slides se suben en ese formato
async function subirSlides(carpeta, pngs) {
  const urls = [];
  for (let i = 0; i < pngs.length; i++) {
    const jpg = await sharp(pngs[i]).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
    urls.push(await subirArchivo(`${carpeta}/slide-${i + 1}.jpg`, jpg, 'image/jpeg'));
  }
  return urls;
}

// Carrusel de un producto: portada, detalle, qué desarrolla, cierre
async function generarProductoUnico(sb, llamarClaude, { productoId, tema = TEMA } = {}) {
  let producto;
  if (productoId) {
    const r = await sb('GET', 'proveedores', { select: 'id,nombre,descripcion,categoria,categoria_grande,proveedor,stock,imagenes', filter: `id=eq.${encodeURIComponent(productoId)}` });
    producto = r?.[0];
    if (!producto) throw new Error(`Producto ${productoId} no encontrado`);
    if (!imagenesDe(producto).length) throw new Error(`El producto ${productoId} no tiene fotos`);
  } else {
    producto = (await candidatos(sb))[0];
    if (!producto) throw new Error('No hay productos con foto y stock para publicar');
  }

  const fotos = imagenesDe(producto);
  const [textos, recorte] = await Promise.all([
    textosProducto(llamarClaude, producto),
    fotoRecortada(producto, fotos[0]),
  ]);

  const datos = { ...textos, fotos, fotoRecortada: recorte, tema, total: 4 };
  // De a una slide por vez para no acumular memoria (plan de 512 MB)
  const pngs = [];
  for (const [i, plantilla] of ['unico_portada', 'unico_detalle', 'unico_desarrolla', 'cierre'].entries()) {
    pngs.push(await renderizar(plantilla, { ...datos, indice: i + 1 }));
  }

  const carpeta = `publicaciones/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  const slides = await subirSlides(carpeta, pngs);

  const { caption, ...contenido } = textos;
  const [borrador] = await sb('POST', 'publicaciones_borrador', {
    body: { tipo: 'unico', tema, producto_ids: [producto.id], contenido: { ...contenido, foto_recortada: recorte }, caption, slides },
    prefer: 'return=representation',
  });
  return borrador;
}

// --- 6. Publicación en Instagram (Graph API) ---

function igConfigurado() {
  return Boolean(process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN);
}

async function graph(metodo, ruta, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const url = metodo === 'GET' ? `${GRAPH}/${ruta}?${body}` : `${GRAPH}/${ruta}`;
  const r = await fetch(url, { method: metodo, body: metodo === 'GET' ? undefined : body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`Instagram: ${data.error?.message || r.status}`);
  return data;
}

async function esperarContenedor(id) {
  for (let i = 0; i < 20; i++) {
    const { status_code } = await graph('GET', id, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`Instagram: contenedor ${id} en estado ${status_code}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Instagram: el contenedor ${id} no terminó de procesarse`);
}

// Publica un carrusel (o una imagen sola) y devuelve el id del posteo
async function publicarEnInstagram({ slides, caption }) {
  const usuario = process.env.IG_USER_ID;
  let creacion;
  if (slides.length === 1) {
    creacion = (await graph('POST', `${usuario}/media`, { image_url: slides[0], caption: caption || '' })).id;
  } else {
    const hijos = [];
    for (const url of slides.slice(0, 10)) {
      hijos.push((await graph('POST', `${usuario}/media`, { image_url: url, is_carousel_item: 'true' })).id);
    }
    creacion = (await graph('POST', `${usuario}/media`, { media_type: 'CAROUSEL', children: hijos.join(','), caption: caption || '' })).id;
  }
  await esperarContenedor(creacion);
  return (await graph('POST', `${usuario}/media_publish`, { creation_id: creacion })).id;
}

// --- Rutas ---

const TRANSICIONES = { borrador: ['aprobado'], aprobado: ['borrador'], publicado: [] };

module.exports = function registrarInstagramAgente(app, sb, llamarClaude) {
  const ok = (res, data) => res.json({ ok: true, ...data });
  const err = (res, msg, status = 500) => res.status(status).json({ ok: false, error: msg });
  let generando = false; // una generación a la vez: el render usa memoria y el plan es chico

  const buscarBorrador = async (id) => (await sb('GET', 'publicaciones_borrador', { filter: `id=eq.${encodeURIComponent(id)}` }))?.[0];

  // Próximos productos según la rotación (para revisar qué va a elegir el agente)
  app.get('/instagram/candidatos', async (req, res) => {
    try {
      const n = Math.min(parseInt(req.query.n, 10) || 10, 50);
      const lista = (await candidatos(sb)).slice(0, n).map((p) => ({
        id: p.id, nombre: p.nombre, proveedor: p.proveedor, stock: p.stock, fotos: imagenesDe(p).length, ultima_publicacion: p.ultima_publicacion,
      }));
      ok(res, { candidatos: lista });
    } catch (e) { err(res, e.message); }
  });

  // Genera un borrador. Body: { tipo: 'unico', producto_id?, tema? }
  app.post('/instagram/generar', async (req, res) => {
    const { tipo = 'unico', producto_id, tema } = req.body || {};
    if (tipo !== 'unico') return err(res, `Tipo de publicación no disponible todavía: ${tipo}`, 400);
    if (generando) return err(res, 'Ya hay una publicación generándose, probá en un rato', 409);
    generando = true;
    try {
      const borrador = await generarProductoUnico(sb, llamarClaude, { productoId: producto_id, tema });
      ok(res, { borrador });
    } catch (e) { err(res, e.message); }
    finally { generando = false; }
  });

  app.get('/instagram/borradores', async (req, res) => {
    try {
      const filtro = req.query.estado ? `estado=eq.${encodeURIComponent(req.query.estado)}` : undefined;
      const borradores = await sb('GET', 'publicaciones_borrador', { filter: filtro, order: 'created_at.desc', limit: 100 });
      ok(res, { borradores: borradores || [] });
    } catch (e) { err(res, e.message); }
  });

  app.get('/instagram/borradores/:id', async (req, res) => {
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      ok(res, { borrador: b });
    } catch (e) { err(res, e.message); }
  });

  // Editar caption y/o cambiar estado (borrador <-> aprobado). "publicado" solo lo pone /publicar.
  app.patch('/instagram/borradores/:id', async (req, res) => {
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado === 'publicado') return err(res, 'Ya está publicado, no se puede modificar', 400);
      const cambios = { updated_at: new Date().toISOString() };
      if (typeof req.body?.caption === 'string') cambios.caption = req.body.caption;
      if (req.body?.estado && req.body.estado !== b.estado) {
        if (!TRANSICIONES[b.estado].includes(req.body.estado)) return err(res, `No se puede pasar de ${b.estado} a ${req.body.estado}`, 400);
        cambios.estado = req.body.estado;
      }
      const [actualizado] = await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(b.id)}`, { body: cambios, prefer: 'return=representation' });
      ok(res, { borrador: actualizado });
    } catch (e) { err(res, e.message); }
  });

  app.delete('/instagram/borradores/:id', async (req, res) => {
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado === 'publicado') return err(res, 'Ya está publicado, no se puede borrar', 400);
      await sb('DELETE', `publicaciones_borrador?id=eq.${encodeURIComponent(b.id)}`, { prefer: 'return=minimal' });
      ok(res, {});
    } catch (e) { err(res, e.message); }
  });

  // Publica un borrador aprobado en Instagram
  app.post('/instagram/borradores/:id/publicar', async (req, res) => {
    if (!igConfigurado()) return err(res, 'Instagram todavía no está conectado (faltan IG_USER_ID e IG_ACCESS_TOKEN)', 501);
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado !== 'aprobado') return err(res, 'Solo se publican borradores aprobados', 400);
      try {
        const mediaId = await publicarEnInstagram({ slides: b.slides, caption: b.caption });
        const ahora = new Date().toISOString();
        const [actualizado] = await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(b.id)}`, {
          body: { estado: 'publicado', ig_media_id: mediaId, publicado_at: ahora, updated_at: ahora, error: null },
          prefer: 'return=representation',
        });
        ok(res, { borrador: actualizado });
      } catch (e) {
        await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(b.id)}`, { body: { error: e.message, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
        throw e;
      }
    } catch (e) { err(res, e.message); }
  });
};

// Exportado para pruebas
module.exports.candidatos = candidatos;
module.exports.promptProductoUnico = promptProductoUnico;
module.exports.parsearJson = parsearJson;
