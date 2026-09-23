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
//   IG_ADMIN_KEY                 clave que exigen las rutas que generan, modifican o publican
//                                (se manda en el header 'x-admin-key')

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

// Carrusel de un producto: por defecto portada, detalle, qué desarrolla y cierre
const SLIDES_UNICO = { portada: 'unico_portada', detalle: 'unico_detalle', desarrolla: 'unico_desarrolla', cierre: 'cierre' };
const SLIDES_UNICO_DEFAULT = ['portada', 'detalle', 'desarrolla', 'cierre'];
const TEMAS_VALIDOS = ['panel', 'color', 'crema'];

async function buscarProducto(sb, id) {
  const r = await sb('GET', 'proveedores', { select: 'id,nombre,descripcion,categoria,categoria_grande,proveedor,stock,imagenes', filter: `id=eq.${encodeURIComponent(id)}` });
  return r?.[0];
}

// Renderiza las slides de un carrusel de producto único y las sube; devuelve las URLs.
// contenido: textos + fotos elegidas (foto_portada, foto_detalle, foto_miniatura) + orden de slides.
async function renderizarUnico(producto, contenido, tema) {
  const fotos = imagenesDe(producto);
  const orden = contenido.slides?.length ? contenido.slides : SLIDES_UNICO_DEFAULT;
  const datos = {
    ...contenido, fotos, tema, total: orden.length,
    fotoRecortada: contenido.foto_recortada,
    fotoPortada: contenido.foto_portada, fotoDetalle: contenido.foto_detalle, fotoMiniatura: contenido.foto_miniatura,
  };
  // De a una slide por vez para no acumular memoria (plan de 512 MB)
  const pngs = [];
  for (const [i, slide] of orden.entries()) {
    pngs.push(await renderizar(SLIDES_UNICO[slide], { ...datos, indice: i + 1 }));
  }
  // Carpeta nueva en cada render: así el navegador e Instagram nunca ven una versión vieja cacheada
  const carpeta = `publicaciones/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  return subirSlides(carpeta, pngs);
}

async function generarProductoUnico(sb, llamarClaude, { productoId, tema = TEMA } = {}) {
  let producto;
  if (productoId) {
    producto = await buscarProducto(sb, productoId);
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

  const { caption, ...resto } = textos;
  const contenido = { ...resto, foto_recortada: recorte, slides: SLIDES_UNICO_DEFAULT, historial: [] };
  const slides = await renderizarUnico(producto, contenido, tema);

  const [borrador] = await sb('POST', 'publicaciones_borrador', {
    body: { tipo: 'unico', tema, producto_ids: [producto.id], contenido, caption, slides },
    prefer: 'return=representation',
  });
  return borrador;
}

// --- 5b. Edición por chat ---
//
// Claude recibe el estado editable del borrador y el pedido, y devuelve el estado nuevo más una
// respuesta corta. Solo puede tocar lo que las plantillas exponen (textos, colores, fotos, slides).

function estadoEditable(b, cantFotos) {
  const c = b.contenido || {};
  return {
    tema: b.tema || TEMA,
    slides: c.slides?.length ? c.slides : SLIDES_UNICO_DEFAULT,
    foto_portada: c.foto_portada ?? 0,
    foto_detalle: c.foto_detalle ?? Math.min(1, cantFotos - 1),
    foto_miniatura: c.foto_miniatura ?? 0,
    nombre: c.nombre, gancho: c.gancho, edad: c.edad, frase: c.frase, bajada: c.bajada,
    habilidades: c.habilidades || [],
    caption: b.caption || '',
  };
}

function promptEdicion(producto, estado, cantFotos, historial, mensaje) {
  const previos = historial.slice(-8).map((h) => `- Pedido: ${h.mensaje}\n  Respuesta: ${h.respuesta}`).join('\n') || '(ninguno)';
  return `Sos quien edita las publicaciones de Instagram de "Crear y Jugar", una juguetería didáctica de Olivos (Buenos Aires). Escribís en español rioplatense (voseo), con tono cálido y pedagógico.

Producto: ${producto.nombre} — ${producto.descripcion || '(sin descripción)'} (marca: ${producto.proveedor || 'sin dato'})

Es un carrusel de Instagram. Estado actual (JSON):
${JSON.stringify(estado, null, 2)}

Qué significa cada campo y qué valores acepta:
- tema: colores del carrusel. "panel" (fondo crema con bloques de color), "color" (cada slide con fondo pleno lavanda/menta/durazno) o "crema" (fondo crema con manchas suaves).
- slides: qué slides van y en qué orden. Valores posibles: "portada", "detalle", "desarrolla" (¿qué desarrolla? con las habilidades), "cierre" (dónde encontrarnos). Tiene que tener al menos "portada".
- foto_portada, foto_detalle, foto_miniatura: qué foto del producto va en la portada, en la slide de detalle y en el circulito de la slide "desarrolla". Son índices desde 0; el producto tiene ${cantFotos} foto(s) (índices 0 a ${cantFotos - 1}). "La primera foto" = 0, "la segunda" = 1, etc.
- nombre (máx. 22 caracteres), gancho (máx. 32, entre signos de exclamación), edad ("+N años" o "N a M años"), frase (máx. 110), bajada (texto de la slide detalle, máx. 100), habilidades (1 a 3, cada una { nombre: 1 a 3 palabras, detalle: máx. 70 }), caption (texto del posteo con hashtags al final).

Reglas:
- Cambiá solo lo que se pide; el resto queda igual.
- NUNCA menciones precios, descuentos ni cuotas. No inventes contenidos ni características del producto.
- Sin emojis en nombre, gancho, frase, bajada ni habilidades.
- Si el pedido es algo que estos campos no permiten (por ejemplo mover elementos, cambiar tamaños o tipografías, agregar fotos que no existen), no cambies nada y explicalo en la respuesta, diciendo qué sí se puede hacer.

Pedidos anteriores en esta conversación:
${previos}

Pedido nuevo: ${mensaje}

Devolvé ÚNICAMENTE un JSON válido:
{ "respuesta": "una o dos oraciones contando qué cambiaste (o por qué no se pudo)", "estado": { ...el estado completo, con los cambios aplicados... } }`;
}

// Toma el estado propuesto por Claude y lo valida campo por campo contra el actual
function validarEstado(nuevo, actual, cantFotos) {
  const e = { ...actual };
  if (!nuevo || typeof nuevo !== 'object') return e;
  if (TEMAS_VALIDOS.includes(nuevo.tema)) e.tema = nuevo.tema;
  if (Array.isArray(nuevo.slides)) {
    const s = [...new Set(nuevo.slides.filter((x) => SLIDES_UNICO[x]))];
    if (s.includes('portada')) e.slides = s;
  }
  for (const k of ['foto_portada', 'foto_detalle', 'foto_miniatura']) {
    if (Number.isInteger(nuevo[k]) && nuevo[k] >= 0 && nuevo[k] < cantFotos) e[k] = nuevo[k];
  }
  for (const k of ['nombre', 'gancho', 'edad', 'frase', 'bajada', 'caption']) {
    if (typeof nuevo[k] === 'string' && nuevo[k].trim()) e[k] = nuevo[k].trim();
  }
  if (Array.isArray(nuevo.habilidades)) {
    const h = nuevo.habilidades.filter((x) => x && typeof x.nombre === 'string' && x.nombre.trim())
      .slice(0, 3).map((x) => ({ nombre: x.nombre.trim(), detalle: typeof x.detalle === 'string' ? x.detalle.trim() : '' }));
    if (h.length) e.habilidades = h;
  }
  if (/\$\s?\d|\bprecios?\b/i.test(e.caption)) e.caption = actual.caption; // nunca precios
  return e;
}

async function editarBorrador(sb, llamarClaude, borrador, mensaje) {
  if (borrador.tipo !== 'unico') throw new Error('Por ahora solo se pueden editar carruseles de un producto');
  const producto = await buscarProducto(sb, borrador.producto_ids?.[0]);
  if (!producto) throw new Error('El producto de este borrador ya no existe');
  const cantFotos = imagenesDe(producto).length;
  if (!cantFotos) throw new Error('El producto ya no tiene fotos');

  const actual = estadoEditable(borrador, cantFotos);
  const historial = borrador.contenido?.historial || [];
  const r = parsearJson(await llamarClaude(promptEdicion(producto, actual, cantFotos, historial, mensaje), { maxTokens: 2000 }));
  const nuevo = validarEstado(r.estado, actual, cantFotos);
  const respuesta = typeof r.respuesta === 'string' ? r.respuesta : 'Listo.';

  const { tema, caption, ...resto } = nuevo;
  const contenido = {
    ...borrador.contenido, ...resto,
    historial: [...historial, { mensaje, respuesta, fecha: new Date().toISOString() }].slice(-20),
  };
  // Si solo cambió el caption no hace falta volver a renderizar las imágenes
  const cambioVisual = JSON.stringify({ ...actual, caption: '' }) !== JSON.stringify({ ...nuevo, caption: '' });
  const slides = cambioVisual ? await renderizarUnico(producto, contenido, tema) : borrador.slides;

  const [actualizado] = await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(borrador.id)}`, {
    // Si estaba aprobado vuelve a borrador: cambió y hay que mirarlo de nuevo
    body: { tema, caption, contenido, slides, estado: 'borrador', updated_at: new Date().toISOString() },
    prefer: 'return=representation',
  });
  return { borrador: actualizado, respuesta };
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

  // Las rutas que gastan (Claude, remove.bg), modifican o publican piden la clave de admin:
  // el backend es público y sin esto cualquiera con la URL podría publicar en la cuenta.
  const requiereClave = (req, res, next) => {
    const clave = process.env.IG_ADMIN_KEY;
    if (!clave) return err(res, 'Falta configurar IG_ADMIN_KEY en el servidor', 503);
    const enviada = Buffer.from(String(req.get('x-admin-key') || ''));
    const esperada = Buffer.from(clave);
    if (enviada.length !== esperada.length || !crypto.timingSafeEqual(enviada, esperada)) return err(res, 'Clave de admin inválida', 401);
    next();
  };

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
  app.post('/instagram/generar', requiereClave, async (req, res) => {
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
  app.patch('/instagram/borradores/:id', requiereClave, async (req, res) => {
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

  // Edición por chat: { mensaje: "cambiá el gancho por algo más divertido" }
  app.post('/instagram/borradores/:id/editar', requiereClave, async (req, res) => {
    const mensaje = String(req.body?.mensaje || '').trim();
    if (!mensaje) return err(res, 'Escribí qué querés cambiar', 400);
    if (mensaje.length > 1000) return err(res, 'El pedido es muy largo', 400);
    if (generando) return err(res, 'Hay otra publicación procesándose, probá en un rato', 409);
    generando = true;
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado === 'publicado') return err(res, 'Ya está publicado, no se puede modificar', 400);
      ok(res, await editarBorrador(sb, llamarClaude, b, mensaje));
    } catch (e) { err(res, e.message); }
    finally { generando = false; }
  });

  app.delete('/instagram/borradores/:id', requiereClave, async (req, res) => {
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado === 'publicado') return err(res, 'Ya está publicado, no se puede borrar', 400);
      await sb('DELETE', `publicaciones_borrador?id=eq.${encodeURIComponent(b.id)}`, { prefer: 'return=minimal' });
      ok(res, {});
    } catch (e) { err(res, e.message); }
  });

  // Publica un borrador aprobado en Instagram
  app.post('/instagram/borradores/:id/publicar', requiereClave, async (req, res) => {
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
module.exports.validarEstado = validarEstado;
