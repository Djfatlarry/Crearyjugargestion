// instagram-agente.js
//
// Agente que arma publicaciones de Instagram para Crear y Jugar:
//   1. elige productos (con foto y stock, rotando los que hace más que no aparecen)
//   2. recorta el fondo de la foto (paso intercambiable, con caché en Storage)
//   3. le pide a Claude los textos (frase pedagógica, edad, habilidades, caption)
//   4. renderiza las slides (instagram-render.js) y las sube a Supabase Storage
//   5. guarda todo como borrador en publicaciones_borrador (borrador -> aprobado -> publicado)
//   6. publica en Instagram (se activa con IG_ACCESS_TOKEN)
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
//   IG_ACCESS_TOKEN              token de la cuenta profesional de Instagram (para publicar). Si es un token de
//                                "inicio de sesión de Instagram" (empieza con IG...) se renueva solo cada semana;
//                                si es de "inicio de sesión de Facebook" (EAA...) hace falta también IG_USER_ID
//   IG_USER_ID                   opcional con token de Instagram (se averigua solo)
//   IG_GRAPH_VERSION             default 'v21.0'
//   IG_ADMIN_KEY                 clave que exigen las rutas que generan, modifican o publican
//                                (se manda en el header 'x-admin-key')

const crypto = require('crypto');
const sharp = require('sharp');
const { htmlDePlantilla, renderHtml } = require('./instagram-render');

const BUCKET = process.env.IG_BUCKET || 'instagram';
const TEMA = process.env.IG_TEMA || 'panel';
const GRAPH_VERSION = process.env.IG_GRAPH_VERSION || 'v21.0';

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
// Sonnet 5: buen equilibrio entre calidad de diseño y costo por mensaje (Opus 5 es más fino y ~2,5x más caro)
const MODELO_DISENO = 'claude-sonnet-5';

async function buscarProducto(sb, id) {
  const r = await sb('GET', 'proveedores', { select: 'id,nombre,descripcion,categoria,categoria_grande,proveedor,stock,imagenes', filter: `id=eq.${encodeURIComponent(id)}` });
  return r?.[0];
}

// HTML de cada slide a partir de las plantillas de código (panel / color / crema)
async function htmlSlidesUnico(producto, contenido, tema) {
  const fotos = imagenesDe(producto);
  const orden = contenido.slides?.length ? contenido.slides : SLIDES_UNICO_DEFAULT;
  const datos = {
    ...contenido, fotos, tema, total: orden.length,
    fotoRecortada: contenido.foto_recortada,
    fotoPortada: contenido.foto_portada, fotoDetalle: contenido.foto_detalle, fotoMiniatura: contenido.foto_miniatura,
  };
  const html = [];
  for (const [i, slide] of orden.entries()) html.push(await htmlDePlantilla(SLIDES_UNICO[slide], { ...datos, indice: i + 1 }));
  return html;
}

// Renderiza y sube un carrusel a partir del HTML de sus slides; devuelve las URLs públicas.
// De a una slide por vez para no acumular memoria (plan de 512 MB).
async function renderizarYSubir(htmlSlides) {
  const cache = new Map();
  const pngs = [];
  for (const html of htmlSlides) pngs.push(await renderHtml(html, cache));
  // Carpeta nueva en cada render: así el navegador e Instagram nunca ven una versión vieja cacheada
  const carpeta = `publicaciones/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  return subirSlides(carpeta, pngs);
}

// --- Plantillas guardadas (diseños creados desde el chat) ---
//
// Son las slides de un borrador con el contenido del producto reemplazado por marcadores.

const MARCADORES_TEXTO = ['nombre', 'gancho', 'edad', 'frase', 'bajada', 'habilidad1', 'detalle1', 'habilidad2', 'detalle2', 'habilidad3', 'detalle3'];
const MARCADORES_FOTO = ['foto_principal', 'foto_secundaria'];

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function valoresMarcadores(textos, fotos) {
  const v = { nombre: textos.nombre, gancho: textos.gancho, edad: textos.edad, frase: textos.frase, bajada: textos.bajada };
  (textos.habilidades || []).forEach((h, i) => { v[`habilidad${i + 1}`] = h.nombre; v[`detalle${i + 1}`] = h.detalle; });
  v.foto_principal = fotos[0];
  v.foto_secundaria = fotos[1] || fotos[0];
  return v;
}

function completarPlantilla(htmlSlides, valores) {
  return htmlSlides.map((html) => html.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => escHtml(valores[k] ?? '')));
}

async function generarProductoUnico(sb, llamarClaude, { productoId, tema = TEMA, plantillaId, programadoPara } = {}) {
  let producto;
  if (productoId) {
    producto = await buscarProducto(sb, productoId);
    if (!producto) throw new Error(`Producto ${productoId} no encontrado`);
    if (!imagenesDe(producto).length) throw new Error(`El producto ${productoId} no tiene fotos`);
  } else {
    producto = (await candidatos(sb))[0];
    if (!producto) throw new Error('No hay productos con foto y stock para publicar');
  }

  let plantilla = null;
  if (plantillaId) {
    plantilla = (await sb('GET', 'plantillas_instagram', { filter: `id=eq.${encodeURIComponent(plantillaId)}` }))?.[0];
    if (!plantilla) throw new Error('Plantilla no encontrada');
  }

  const fotos = imagenesDe(producto);
  const [textos, recorte] = await Promise.all([
    textosProducto(llamarClaude, producto),
    plantilla ? null : fotoRecortada(producto, fotos[0]),
  ]);

  const { caption, ...resto } = textos;
  const contenido = { ...resto, foto_recortada: recorte, historial: [], versiones: [] };
  if (plantilla) contenido.plantilla = { id: plantilla.id, nombre: plantilla.nombre };
  else contenido.slides = SLIDES_UNICO_DEFAULT;
  contenido.html_slides = plantilla
    ? completarPlantilla(plantilla.slides, valoresMarcadores(textos, fotos))
    : await htmlSlidesUnico(producto, contenido, tema);
  const slides = await renderizarYSubir(contenido.html_slides);

  const [borrador] = await sb('POST', 'publicaciones_borrador', {
    body: {
      tipo: 'unico', tema: plantilla ? `plantilla: ${plantilla.nombre}` : tema, producto_ids: [producto.id], contenido, caption, slides,
      programado_para: programadoPara || null,
    },
    prefer: 'return=representation',
  });
  return borrador;
}

// --- Publicación institucional (imagen única, sin producto) ---

function promptInstitucional(idea, previas) {
  return `Sos quien escribe las publicaciones de Instagram de "Crear y Jugar", una juguetería didáctica de Olivos (Buenos Aires). Escribís en español rioplatense (voseo), con tono cálido y pedagógico, pensando en madres, padres, docentes y quienes regalan.

Esta vez es una publicación institucional (sin producto): una imagen con una frase grande y un texto corto, que transmita qué es Crear y Jugar y por qué el juego importa.
${idea ? `Idea de la dueña para esta publicación: ${idea}` : 'Elegí vos el tema: por ejemplo el juego y el aprendizaje, jugar en familia, cómo elegir un juguete según la edad, el juego libre, la curiosidad, o el local como lugar para descubrir.'}
${previas.length ? `Frases que ya usamos (no las repitas ni hagas algo muy parecido):
${previas.map((f) => `- ${f}`).join('\n')}` : ''}

Reglas:
- NUNCA menciones precios, descuentos ni cuotas. No inventes datos del local (horarios, promociones, eventos).
- Sin emojis en la frase ni en el texto. En el caption podés usar pocos (2 o 3 como máximo).
- Frases cortas y concretas; nada de palabras rimbombantes.

Devolvé ÚNICAMENTE un JSON válido:
{
  "frase": "frase principal, memorable (máx. 70 caracteres)",
  "texto": "texto que la acompaña (máx. 170 caracteres)",
  "caption": "texto del posteo: 2 párrafos cortos, cálido, que cierre invitando a visitar la tienda online (link en la bio) o el local en Ricardo Gutiérrez 1215, Olivos. Al final, en una línea aparte, entre 8 y 12 hashtags en español (incluí #CrearYJugar y #JuguetesDidacticos)."
}`;
}

async function generarInstitucional(sb, llamarClaude, { idea, programadoPara } = {}) {
  const previas = (await sb('GET', 'publicaciones_borrador', { select: 'contenido', filter: 'tipo=eq.institucional', order: 'created_at.desc', limit: 10 }) || [])
    .map((b) => b.contenido?.frase).filter(Boolean);
  const t = parsearJson(await llamarClaude(promptInstitucional(idea, previas), { maxTokens: 1500 }));
  if (!t.frase || !t.texto) throw new Error('La IA no devolvió la frase; probá de nuevo');
  if (/\$\s?\d|\bprecios?\b/i.test(t.caption || '')) throw new Error('El caption generado menciona precios; volvé a generar');
  const contenido = {
    nombre: 'Institucional', frase: t.frase, texto: t.texto, idea: idea || null, historial: [], versiones: [],
    html_slides: [await htmlDePlantilla('institucional', { frase: t.frase, texto: t.texto })],
  };
  const slides = await renderizarYSubir(contenido.html_slides);
  const [borrador] = await sb('POST', 'publicaciones_borrador', {
    body: { tipo: 'institucional', tema: 'institucional', producto_ids: [], contenido, caption: t.caption, slides, programado_para: programadoPara || null },
    prefer: 'return=representation',
  });
  return borrador;
}

// --- Carrusel de varios productos ---
//
// Claude elige 3 productos que combinen (un tema) entre los próximos de la rotación y escribe los textos.
// Slides: portada con las fotos en círculos, una por producto y el cierre.

function promptMulti(lista, idea) {
  return `Sos quien escribe las publicaciones de Instagram de "Crear y Jugar", una juguetería didáctica de Olivos (Buenos Aires). Escribís en español rioplatense (voseo), con tono cálido y pedagógico, pensando en madres, padres, docentes y quienes regalan.

Vamos a armar un carrusel con 3 productos que tengan algo en común (un tema: por ejemplo arte y manualidades, encastre y construcción, primeros años, juegos de mesa, ciencia, juego al aire libre).
${idea ? `Tema pedido por la dueña: ${idea}. Elegí los 3 productos que mejor encajen.` : 'Elegí vos el tema que mejor agrupe 3 productos de la lista, dándole prioridad a los primeros (son los que hace más que no se publican).'}

Productos disponibles (id | nombre | descripción | categoría | marca):
${lista.map((p) => `${p.id} | ${p.nombre} | ${(p.descripcion || '-').slice(0, 160)} | ${p.categoria || p.categoria_grande || '-'} | ${p.proveedor || '-'}`).join('\n')}

Reglas:
- Usá solo ids de la lista, exactamente como aparecen.
- NUNCA menciones precios, descuentos ni cuotas. No inventes contenidos, piezas ni características que no surjan del nombre o la descripción; si hay poca información, hablá de lo que ese tipo de juego propone en general.
- Sin emojis en título, subtítulo ni textos de productos. En el caption podés usar pocos (2 o 3 como máximo).

Devolvé ÚNICAMENTE un JSON válido:
{
  "titulo": "título del tema (máx. 32 caracteres)",
  "subtitulo": "bajada que invite a deslizar (máx. 70 caracteres)",
  "productos": [
    { "id": "...", "nombre": "nombre corto para mostrar (máx. 22 caracteres, sin códigos ni medidas)", "edad": "+N años o N a M años", "frase": "qué desarrolla este juego (máx. 90 caracteres)", "habilidades": ["1 a 3 palabras", "1 a 3 palabras"] }
  ],
  "caption": "texto del posteo: 2 o 3 párrafos cortos que presenten el tema y los productos, cierre invitando a la tienda online (link en la bio) o al local en Ricardo Gutiérrez 1215, Olivos. Al final, en una línea aparte, entre 8 y 12 hashtags en español (incluí #CrearYJugar y #JuguetesDidacticos)."
}
Tienen que ser exactamente 3 productos distintos.`;
}

async function htmlSlidesMulti(contenido, productosPorId) {
  const prods = contenido.productos;
  const total = prods.length + 2;
  const html = [await htmlDePlantilla('multi_portada', {
    titulo: contenido.titulo, subtitulo: contenido.subtitulo,
    fotos: prods.map((p) => imagenesDe(productosPorId[p.id])[0]),
  })];
  for (const [i, p] of prods.entries()) {
    html.push(await htmlDePlantilla('producto', {
      nombre: p.nombre, edad: p.edad, frase: p.frase, habilidades: p.habilidades,
      foto: imagenesDe(productosPorId[p.id])[0], indice: i + 2, total,
    }));
  }
  html.push(await htmlDePlantilla('cierre', { indice: total, total }));
  return html;
}

async function generarMulti(sb, llamarClaude, { idea, programadoPara } = {}) {
  const lista = (await candidatos(sb)).slice(0, 25);
  if (lista.length < 3) throw new Error('Hacen falta al menos 3 productos con foto y stock');
  const t = parsearJson(await llamarClaude(promptMulti(lista, idea), { maxTokens: 2500 }));
  const porId = Object.fromEntries(lista.map((p) => [p.id, p]));
  const productos = (t.productos || [])
    .filter((p, i, arr) => porId[p?.id] && arr.findIndex((x) => x.id === p.id) === i)
    .slice(0, 3)
    .map((p) => ({
      id: p.id, nombre: String(p.nombre || porId[p.id].nombre).slice(0, 40), edad: p.edad || '',
      frase: p.frase || '', habilidades: (p.habilidades || []).filter((x) => typeof x === 'string').slice(0, 3),
    }));
  if (productos.length < 2) throw new Error('La IA no eligió productos válidos; probá de nuevo');
  if (!t.titulo) throw new Error('La IA no devolvió el título; probá de nuevo');
  if (/\$\s?\d|\bprecios?\b/i.test(t.caption || '')) throw new Error('El caption generado menciona precios; volvé a generar');

  const contenido = { nombre: t.titulo, titulo: t.titulo, subtitulo: t.subtitulo || '', productos, idea: idea || null, historial: [], versiones: [] };
  contenido.html_slides = await htmlSlidesMulti(contenido, porId);
  const slides = await renderizarYSubir(contenido.html_slides);
  const [borrador] = await sb('POST', 'publicaciones_borrador', {
    body: { tipo: 'multi', tema: 'varios productos', producto_ids: productos.map((p) => p.id), contenido, caption: t.caption, slides, programado_para: programadoPara || null },
    prefer: 'return=representation',
  });
  return borrador;
}

// --- 5b. Edición por chat ---
//
// Conversación libre con Claude sobre el borrador. Claude ve cómo quedaron las slides (imágenes) y su
// HTML, y devuelve las slides que cambia. Todo lo que devuelve se valida renderizándolo antes de guardar.

const SISTEMA_DISENO = `Sos quien diseña las publicaciones de Instagram de "Crear y Jugar", una juguetería didáctica de Olivos (Buenos Aires). Conversás con la dueña del local, que no es técnica: respondele en español rioplatense (voseo), con calidez y en pocas palabras. Nunca le hables de HTML, CSS ni código: hablale de lo que se ve.

Trabajás sobre un carrusel de slides de 1080x1350 px. Cada slide es HTML con estilos en línea que se dibuja con Satori (no es un navegador). Reglas técnicas obligatorias:
- La raíz de cada slide es un único <div> con width:1080px;height:1350px;position:relative.
- Solo flexbox. Todo <div> lleva display:flex explícito. No existen grid, float ni display:block/inline.
- Estilos solo en el atributo style. Nada de <style>, clases, <script>, <p> ni <span>: el texto va dentro de <div>.
- position:absolute está permitido (con top/left/right/bottom en px).
- Tipografías disponibles, y ninguna otra: 'Playfair Display' (normal 700 y 800; italic 400 y 700) y Lexend (400, 500, 600).
- Imágenes: solo <img> con un src de la lista que te paso, siempre con width y height en px. Podés usar object-fit (cover o contain), border-radius y transform.
- Formas y decoraciones: <svg> con <path>, <circle> o <rect> (atributos fill y transform), con width, height y viewBox.
- Soportado: border, border-radius, box-shadow, opacity, transform (rotate, translate, scale), background-color, background-image con linear-gradient, letter-spacing, text-transform, line-height, text-align, gap, padding, margin.
- Paleta de la marca: lavanda #8F83B9, durazno #F7D5C4, menta #BCE3DE, manteca #FFF0B3, violeta oscuro #52486C (textos), crema #FFF8EE, blanco.

Contenido: nunca precios, descuentos ni cuotas; no inventes características del producto; sin emojis en las imágenes. Si cambia la cantidad de slides, actualizá los contadores tipo "2 / 4".

Respondé siempre con este formato:
<respuesta>lo que le decís (1 a 3 oraciones)</respuesta>
Por cada slide que modificás o agregás, el HTML completo:
<slide id="N">...</slide>   (N = número de la slide que reemplazás, o nueva1, nueva2... para slides nuevas)
Si cambia el orden, sacás o agregás slides, la lista final: <orden>1,2,nueva1,4</orden> (lo que no aparece se elimina). Si no cambia, no lo pongas.
Si cambia el texto del posteo: <caption>texto completo</caption>
Si es una pregunta o un comentario sin cambios, respondé solo con <respuesta>. Si algo no se puede hacer, decilo y ofrecé una alternativa.`;

function extraer(texto, tag) {
  const m = texto.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

function extraerSlides(texto) {
  const slides = {};
  for (const m of texto.matchAll(/<slide id="([^"]+)">([\s\S]*?)<\/slide>/g)) slides[m[1].trim()] = m[2].trim();
  return slides;
}

// Imágenes que puede usar una slide: fotos del producto, recorte y logo (nada de URLs externas)
function fuentesPermitidas(producto, contenido) {
  return new Set(['asset:logo', ...imagenesDe(producto), contenido.foto_recortada].filter(Boolean));
}

async function validarSlide(html, permitidas, cache) {
  if (/<script|<style|\son\w+\s*=/i.test(html)) throw new Error('contiene elementos no permitidos (script, style o eventos)');
  for (const m of html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)) {
    if (!permitidas.has(m[1].replace(/&amp;/g, '&'))) throw new Error(`usa una imagen que no está en la lista: ${m[1].slice(0, 80)}`);
  }
  return renderHtml(html, cache);
}

// Miniaturas JPEG de las slides actuales, para que Claude vea cómo quedó cada una
async function miniaturas(urls) {
  const out = [];
  for (const url of urls) {
    try {
      const jpg = await sharp(await bajar(url)).resize(540).jpeg({ quality: 80 }).toBuffer();
      out.push(jpg.toString('base64'));
    } catch { out.push(null); }
  }
  return out;
}

async function editarBorrador(sb, llamarClaude, borrador, mensaje) {
  const contenido = { ...(borrador.contenido || {}) };
  // Las publicaciones institucionales no tienen producto: solo pueden usar el logo como imagen.
  // Los carruseles de varios productos pueden usar las fotos de todos sus productos.
  const productos = (await Promise.all((borrador.producto_ids || []).map((id) => buscarProducto(sb, id)))).filter(Boolean);
  if (borrador.producto_ids?.length && !productos.length) throw new Error('Los productos de este borrador ya no existen');
  const producto = productos[0] || null;
  // Borradores generados antes del chat libre: se arma el HTML desde las plantillas
  const htmlActual = contenido.html_slides?.length ? contenido.html_slides : await htmlSlidesUnico(producto, contenido, borrador.tema || TEMA);
  const historial = contenido.historial || [];
  const permitidas = new Set(['asset:logo', ...productos.flatMap((p) => [...fuentesPermitidas(p, contenido)])]);

  const imgs = await miniaturas(borrador.slides || []);
  const bloques = [];
  htmlActual.forEach((_, i) => {
    bloques.push({ type: 'text', text: `Slide ${i + 1} (así se ve ahora):` });
    if (imgs[i]) bloques.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgs[i] } });
  });
  bloques.push({
    type: 'text',
    text: `${productos.length
    ? productos.map((p) => `Producto: ${p.nombre} — ${p.descripcion || '(sin descripción)'} (marca: ${p.proveedor || 'sin dato'})`).join('\n')
    : 'Publicación institucional de la marca (sin producto).'}

Imágenes que podés usar en src: ${[...permitidas].join(' , ')}

HTML actual de cada slide:
${htmlActual.map((h, i) => `<slide id="${i + 1}">${h}</slide>`).join('\n')}

Texto actual del posteo:
<caption>${borrador.caption || ''}</caption>

Pedido: ${mensaje}`,
  });

  // Conversación previa (solo texto) + el pedido nuevo con imágenes y HTML
  const conversacion = [];
  for (const h of historial.slice(-6)) {
    conversacion.push({ role: 'user', content: h.mensaje }, { role: 'assistant', content: h.respuesta });
  }
  conversacion.push({ role: 'user', content: bloques });

  const opciones = { model: MODELO_DISENO, maxTokens: 16000, system: SISTEMA_DISENO, effort: 'medium' };
  let salida = await llamarClaude(conversacion, opciones);
  let respuesta = extraer(salida, 'respuesta') || salida.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim() || 'Listo.';
  let nuevas = extraerSlides(salida);
  const ordenTxt = extraer(salida, 'orden');
  const caption = extraer(salida, 'caption');

  // Validar las slides nuevas renderizándolas; si alguna falla, un reintento pidiendo la corrección
  const cache = new Map();
  const errores = async () => {
    const e = {};
    for (const [id, html] of Object.entries(nuevas)) {
      try { await validarSlide(html, permitidas, cache); } catch (err) { e[id] = err.message; }
    }
    return e;
  };
  let fallidas = await errores();
  if (Object.keys(fallidas).length) {
    const detalle = Object.entries(fallidas).map(([id, m]) => `- Slide ${id}: ${m}`).join('\n');
    const retry = await llamarClaude([
      ...conversacion,
      { role: 'assistant', content: salida },
      { role: 'user', content: `Estas slides dieron error al dibujarse:\n${detalle}\nCorregilas respetando las reglas técnicas. Devolvé solo esas slides con el mismo formato <slide id="...">...</slide>.` },
    ], opciones);
    Object.assign(nuevas, extraerSlides(retry));
    fallidas = await errores();
    for (const id of Object.keys(fallidas)) delete nuevas[id];
  }

  // Armar la lista final de slides
  const orden = ordenTxt
    ? ordenTxt.split(',').map((x) => x.trim()).filter(Boolean)
    : [...htmlActual.map((_, i) => String(i + 1)), ...Object.keys(nuevas).filter((id) => !/^\d+$/.test(id))];
  const htmlFinal = orden.map((id) => nuevas[id] ?? (/^\d+$/.test(id) ? htmlActual[Number(id) - 1] : undefined)).filter(Boolean);
  if (!htmlFinal.length) throw new Error('El cambio dejaba el carrusel sin slides; no se aplicó');

  const cambioSlides = JSON.stringify(htmlFinal) !== JSON.stringify(htmlActual);
  const captionFinal = caption && !/\$\s?\d|\bprecios?\b/i.test(caption) ? caption : borrador.caption;
  if (Object.keys(fallidas).length) {
    respuesta += ' (Hubo una parte que no pude dibujar bien, así que esa slide quedó como estaba.)';
  }

  const hubo = cambioSlides || captionFinal !== borrador.caption;
  const versiones = contenido.versiones || [];
  if (hubo) versiones.push({ html_slides: htmlActual, slides: borrador.slides, caption: borrador.caption, fecha: new Date().toISOString() });

  const slides = cambioSlides ? await renderizarYSubir(htmlFinal) : borrador.slides;
  const nuevoContenido = {
    ...contenido,
    html_slides: htmlFinal,
    versiones: versiones.slice(-15),
    historial: [...historial, { mensaje, respuesta, fecha: new Date().toISOString() }].slice(-30),
  };

  const [actualizado] = await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(borrador.id)}`, {
    // Si estaba aprobado y cambió, vuelve a borrador para mirarlo de nuevo
    body: { caption: captionFinal, contenido: nuevoContenido, slides, ...(hubo ? { estado: 'borrador' } : {}), updated_at: new Date().toISOString() },
    prefer: 'return=representation',
  });
  return { borrador: actualizado, respuesta };
}

async function deshacerBorrador(sb, borrador) {
  const contenido = { ...(borrador.contenido || {}) };
  const versiones = [...(contenido.versiones || [])];
  const anterior = versiones.pop();
  if (!anterior) throw new Error('No hay cambios para deshacer');
  const historial = [...(contenido.historial || []), { mensaje: '(deshacer)', respuesta: 'Volví a la versión anterior.', fecha: new Date().toISOString() }];
  const [actualizado] = await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(borrador.id)}`, {
    body: {
      caption: anterior.caption, slides: anterior.slides, estado: 'borrador', updated_at: new Date().toISOString(),
      contenido: { ...contenido, html_slides: anterior.html_slides, versiones, historial: historial.slice(-30) },
    },
    prefer: 'return=representation',
  });
  return actualizado;
}

// Convierte el diseño de un borrador en plantilla: Claude reemplaza lo propio del producto por marcadores
async function guardarComoPlantilla(sb, llamarClaude, borrador, nombre) {
  if (borrador.tipo !== 'unico') throw new Error('Por ahora solo se pueden guardar como plantilla los carruseles de producto');
  const producto = await buscarProducto(sb, borrador.producto_ids?.[0]);
  if (!producto) throw new Error('El producto de este borrador ya no existe');
  const contenido = borrador.contenido || {};
  const html = contenido.html_slides?.length ? contenido.html_slides : await htmlSlidesUnico(producto, contenido, borrador.tema || TEMA);
  const fotos = imagenesDe(producto);

  const prompt = `Tengo el diseño de un carrusel de Instagram (HTML de cada slide) hecho para un producto puntual. Quiero reutilizar el diseño para otros productos.
Reemplazá el contenido propio de ESTE producto por marcadores, sin cambiar nada del diseño:
- Textos: {{nombre}}, {{gancho}}, {{edad}}, {{frase}}, {{bajada}}, {{habilidad1}}, {{detalle1}}, {{habilidad2}}, {{detalle2}}, {{habilidad3}}, {{detalle3}}. Usá el que mejor corresponda a cada texto; si un texto propio del producto no encaja en ninguno, usá el más parecido.
- Fotos del producto en el src de <img>: {{foto_principal}} y {{foto_secundaria}}. Las fotos del producto son: ${[...fotos, contenido.foto_recortada].filter(Boolean).join(' , ')}. El logo (asset:logo) queda igual.
- Lo que es de la marca y no del producto (dirección, usuario de Instagram, web, "Deslizá", contadores tipo "2 / 4", títulos genéricos como "¿qué desarrolla?") queda igual.

${html.map((h, i) => `<slide id="${i + 1}">${h}</slide>`).join('\n')}

Devolvé todas las slides con el mismo formato <slide id="N">...</slide> y nada más.`;
  const salida = await llamarClaude(prompt, { model: MODELO_DISENO, maxTokens: 16000, effort: 'low' });
  const slidesPlantilla = extraerSlides(salida);
  const lista = html.map((_, i) => slidesPlantilla[String(i + 1)]).filter(Boolean);
  if (lista.length !== html.length || !lista.join('').includes('{{')) throw new Error('No se pudo armar la plantilla; probá de nuevo');

  // Prueba: completar con los datos de este producto y dibujar cada slide
  const valores = valoresMarcadores({ ...contenido, habilidades: contenido.habilidades || [] }, fotos);
  const cache = new Map();
  for (const h of completarPlantilla(lista, valores)) await renderHtml(h, cache);

  const [plantilla] = await sb('POST', 'plantillas_instagram', {
    body: { nombre, slides: lista, creado_desde: borrador.id },
    prefer: 'return=representation',
  });
  return plantilla;
}

// --- 6. Publicación en Instagram (Graph API) ---

// Hay dos formas de conectar la API: con inicio de sesión de Instagram (token IG..., host
// graph.instagram.com, no necesita página de Facebook) o con inicio de sesión de Facebook (token EAA...,
// host graph.facebook.com). Se detecta por el token.
const ig = { token: null, base: null, userId: null, usuario: null };

function igConfigurado() {
  return Boolean(ig.token || process.env.IG_ACCESS_TOKEN);
}

function esTokenInstagram(t) {
  return String(t || '').startsWith('IG');
}

function hostGraph() {
  return esTokenInstagram(ig.token) ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
}

async function graph(metodo, ruta, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: ig.token });
  const url = `${hostGraph()}/${GRAPH_VERSION}/${ruta}`;
  const r = await fetch(metodo === 'GET' ? `${url}?${body}` : url, { method: metodo, body: metodo === 'GET' ? undefined : body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`Instagram: ${data.error?.message || r.status}`);
  return data;
}

// Carga el token vigente: el de la variable de entorno, o el renovado guardado en config si viene de ese
// mismo token (si alguien carga un token nuevo en Render, se usa el nuevo).
async function prepararToken(sb) {
  const env = process.env.IG_ACCESS_TOKEN;
  if (!env) { ig.token = null; return; }
  const base = crypto.createHash('sha1').update(env).digest('hex').slice(0, 12);
  if (ig.base !== base) {
    const guardado = await leerConfig(sb, 'instagram_token');
    ig.token = guardado?.base === base && guardado.token ? guardado.token : env;
    ig.base = base;
    ig.userId = null;
  }
}

// Los tokens de Instagram duran 60 días: se renuevan una vez por semana (necesitan tener 24 h)
async function renovarTokenSiHaceFalta(sb) {
  if (!esTokenInstagram(ig.token)) return;
  const guardado = await leerConfig(sb, 'instagram_token');
  const ultimo = guardado?.base === ig.base ? Date.parse(guardado.renovado_at || guardado.intento_at || 0) : 0;
  const esperar = guardado?.renovado_at ? 7 * 86400e3 : 86400e3;
  if (Date.now() - ultimo < esperar) return;
  try {
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(ig.token)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) throw new Error(data.error?.message || r.status);
    ig.token = data.access_token;
    await guardarConfig(sb, 'instagram_token', {
      base: ig.base, token: data.access_token, renovado_at: new Date().toISOString(),
      vence: new Date(Date.now() + (data.expires_in || 0) * 1000).toISOString(),
    });
  } catch (e) {
    console.error(`[instagram] no se pudo renovar el token: ${e.message}`);
    await guardarConfig(sb, 'instagram_token', { ...(guardado?.base === ig.base ? guardado : { base: ig.base }), intento_at: new Date().toISOString() });
  }
}

// ID y usuario de la cuenta conectada
async function cuentaIG() {
  if (!ig.userId) {
    if (esTokenInstagram(ig.token)) {
      const me = await graph('GET', 'me', { fields: 'user_id,username' });
      ig.userId = me.user_id || me.id;
      ig.usuario = me.username;
    } else {
      if (!process.env.IG_USER_ID) throw new Error('Con un token de Facebook hace falta IG_USER_ID');
      ig.userId = process.env.IG_USER_ID;
      ig.usuario = (await graph('GET', ig.userId, { fields: 'username' })).username;
    }
  }
  return { id: ig.userId, usuario: ig.usuario };
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
  const { id: usuario } = await cuentaIG();
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

async function publicarBorrador(sb, b) {
  try {
    const mediaId = await publicarEnInstagram({ slides: b.slides, caption: b.caption });
    const ahora = new Date().toISOString();
    const [actualizado] = await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(b.id)}`, {
      body: { estado: 'publicado', ig_media_id: mediaId, publicado_at: ahora, updated_at: ahora, error: null },
      prefer: 'return=representation',
    });
    return actualizado;
  } catch (e) {
    await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(b.id)}`, { body: { error: e.message, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
    throw e;
  }
}

// --- 7. Agenda (calendarización) ---
//
// Días y horarios de publicación + generación automática semanal. Se guarda en la tabla config
// (clave 'instagram_agenda'). Días con numeración ISO: 1 = lunes ... 7 = domingo. Horario de Argentina.

const AGENDA_DEFAULT = {
  slots: [{ dia: 2, hora: '21:00' }, { dia: 4, hora: '21:00' }, { dia: 6, hora: '10:00' }],
  generacion: { dia: 7, hora: '20:00' }, // el domingo a la noche arma los borradores de la semana
  auto: true,
};
const OFFSET_AR = '-03:00'; // Argentina no tiene horario de verano

function partesAR(fecha) {
  const d = new Date(fecha.getTime() - 3 * 3600e3);
  return { ymd: d.toISOString().slice(0, 10), dow: d.getUTCDay() || 7, hm: d.toISOString().slice(11, 16) };
}

function fechaAR(ymd, hora) {
  return new Date(`${ymd}T${hora}:00${OFFSET_AR}`);
}

// Próximas fechas de publicación según la agenda, desde `desde` y hasta `dias` días después
function proximosSlots(agenda, desde = new Date(), dias = 14) {
  const out = [];
  for (let i = 0; i <= dias; i++) {
    const { ymd, dow } = partesAR(new Date(desde.getTime() + i * 86400e3));
    for (const s of agenda.slots) {
      if (s.dia !== dow) continue;
      const f = fechaAR(ymd, s.hora);
      if (f > desde && f - desde <= dias * 86400e3) out.push(f);
    }
  }
  return out.sort((a, b) => a - b);
}

async function leerConfig(sb, key) {
  return (await sb('GET', 'config', { filter: `key=eq.${key}` }))?.[0]?.value;
}

async function guardarConfig(sb, key, value) {
  await sb('POST', 'config', { body: { key, value, updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
}

async function leerAgenda(sb) {
  return { ...AGENDA_DEFAULT, ...((await leerConfig(sb, 'instagram_agenda')) || {}) };
}

function validarAgenda(a) {
  const hora = (h) => typeof h === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(h);
  const dia = (d) => Number.isInteger(d) && d >= 1 && d <= 7;
  if (!a || !Array.isArray(a.slots) || a.slots.length > 21) throw new Error('Agenda inválida');
  const slots = a.slots.map((s) => ({ dia: Number(s.dia), hora: s.hora }));
  if (!slots.every((s) => dia(s.dia) && hora(s.hora))) throw new Error('Día u hora inválidos en la agenda');
  const generacion = a.generacion ? { dia: Number(a.generacion.dia), hora: a.generacion.hora } : AGENDA_DEFAULT.generacion;
  if (!dia(generacion.dia) || !hora(generacion.hora)) throw new Error('Día u hora de generación inválidos');
  return { slots, generacion, auto: a.auto !== false };
}

// Arma un borrador para cada fecha de los próximos 7 días que todavía no tenga uno asignado
async function generarSemana(sb, llamarClaude, ahora = new Date()) {
  const agenda = await leerAgenda(sb);
  const slots = proximosSlots(agenda, ahora, 7);
  const ocupados = await sb('GET', 'publicaciones_borrador', { select: 'programado_para', filter: `programado_para=gte.${ahora.toISOString()}` });
  const tomados = new Set((ocupados || []).map((o) => new Date(o.programado_para).getTime()));
  const creados = [];
  const errores = [];
  for (const f of slots) {
    if (tomados.has(f.getTime())) continue;
    try {
      const b = await generarProductoUnico(sb, llamarClaude, { programadoPara: f.toISOString() });
      creados.push({ id: b.id, programado_para: b.programado_para });
    } catch (e) {
      errores.push(e.message);
      console.error(`[instagram] no se pudo generar el borrador para ${f.toISOString()}: ${e.message}`);
    }
  }
  return { creados, errores };
}

// --- Rutas ---

const TRANSICIONES = { borrador: ['aprobado'], aprobado: ['borrador'], publicado: [] };

// Cada 5 minutos: genera los borradores de la semana en el día/hora de la agenda, y publica los
// aprobados cuya fecha ya llegó (si Instagram está conectado). Render starter corre una sola
// instancia siempre encendida, así que alcanza con un intervalo en el proceso.
async function cicloAgenda(sb, llamarClaude, estado, ahora = new Date()) {
  if (estado.generando) return;
  try {
    await prepararToken(sb);
    await renovarTokenSiHaceFalta(sb);
    const agenda = await leerAgenda(sb);
    const p = partesAR(ahora);
    if (agenda.auto && p.dow === agenda.generacion.dia && p.hm >= agenda.generacion.hora) {
      const ultima = await leerConfig(sb, 'instagram_ultima_generacion');
      if (ultima?.fecha !== p.ymd) {
        // Se marca antes de generar: si algo falla no se reintenta en loop (queda el botón manual)
        await guardarConfig(sb, 'instagram_ultima_generacion', { fecha: p.ymd });
        estado.generando = true;
        try { await generarSemana(sb, llamarClaude, ahora); } finally { estado.generando = false; }
      }
    }
    if (igConfigurado()) {
      const debidos = await sb('GET', 'publicaciones_borrador', { filter: `estado=eq.aprobado&programado_para=lte.${ahora.toISOString()}` });
      // Los que ya fallaron no se reintentan solos: quedan con el error a la vista para publicarlos a mano
      for (const b of (debidos || []).filter((x) => !x.error)) {
        await publicarBorrador(sb, b).catch((e) => console.error(`[instagram] no se pudo publicar ${b.id}: ${e.message}`));
      }
    }
  } catch (e) {
    console.error(`[instagram] agenda: ${e.message}`);
  }
}

module.exports = function registrarInstagramAgente(app, sb, llamarClaude) {
  const ok = (res, data) => res.json({ ok: true, ...data });
  const err = (res, msg, status = 500) => res.status(status).json({ ok: false, error: msg });
  const estado = { generando: false }; // una generación a la vez: el render usa memoria y el plan es chico

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

  // Genera un borrador. Body: { tipo: 'unico' | 'multi' | 'institucional', producto_id?, tema?, plantilla_id?, idea?, programado_para? }
  app.post('/instagram/generar', requiereClave, async (req, res) => {
    const { tipo = 'unico', producto_id, tema, plantilla_id, programado_para, idea } = req.body || {};
    if (!['unico', 'institucional', 'multi'].includes(tipo)) return err(res, `Tipo de publicación no disponible todavía: ${tipo}`, 400);
    if (programado_para && Number.isNaN(Date.parse(programado_para))) return err(res, 'Fecha inválida', 400);
    if (estado.generando) return err(res, 'Ya hay una publicación generándose, probá en un rato', 409);
    estado.generando = true;
    try {
      const programadoPara = programado_para ? new Date(programado_para).toISOString() : undefined;
      const ideaLimpia = String(idea || '').trim().slice(0, 300) || null;
      const borrador = tipo === 'institucional'
        ? await generarInstitucional(sb, llamarClaude, { idea: ideaLimpia, programadoPara })
        : tipo === 'multi'
          ? await generarMulti(sb, llamarClaude, { idea: ideaLimpia, programadoPara })
          : await generarProductoUnico(sb, llamarClaude, { productoId: producto_id, tema, plantillaId: plantilla_id, programadoPara });
      ok(res, { borrador });
    } catch (e) { err(res, e.message); }
    finally { estado.generando = false; }
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
      if (req.body && 'programado_para' in req.body) {
        const f = req.body.programado_para;
        if (f !== null && Number.isNaN(Date.parse(f))) return err(res, 'Fecha inválida', 400);
        cambios.programado_para = f === null ? null : new Date(f).toISOString();
      }
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
    if (estado.generando) return err(res, 'Hay otra publicación procesándose, probá en un rato', 409);
    estado.generando = true;
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado === 'publicado') return err(res, 'Ya está publicado, no se puede modificar', 400);
      ok(res, await editarBorrador(sb, llamarClaude, b, mensaje));
    } catch (e) { err(res, e.message); }
    finally { estado.generando = false; }
  });

  app.post('/instagram/borradores/:id/deshacer', requiereClave, async (req, res) => {
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado === 'publicado') return err(res, 'Ya está publicado, no se puede modificar', 400);
      ok(res, { borrador: await deshacerBorrador(sb, b) });
    } catch (e) { err(res, e.message); }
  });

  // Plantillas guardadas: { nombre }
  app.post('/instagram/borradores/:id/guardar-plantilla', requiereClave, async (req, res) => {
    const nombre = String(req.body?.nombre || '').trim().slice(0, 60);
    if (!nombre) return err(res, 'Ponele un nombre a la plantilla', 400);
    if (estado.generando) return err(res, 'Hay otra publicación procesándose, probá en un rato', 409);
    estado.generando = true;
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      ok(res, { plantilla: await guardarComoPlantilla(sb, llamarClaude, b, nombre) });
    } catch (e) { err(res, e.message); }
    finally { estado.generando = false; }
  });

  app.get('/instagram/plantillas', async (req, res) => {
    try {
      const plantillas = await sb('GET', 'plantillas_instagram', { select: 'id,nombre,created_at', order: 'created_at.desc' });
      ok(res, { plantillas: plantillas || [] });
    } catch (e) { err(res, e.message); }
  });

  app.delete('/instagram/plantillas/:id', requiereClave, async (req, res) => {
    try {
      await sb('DELETE', `plantillas_instagram?id=eq.${encodeURIComponent(req.params.id)}`, { prefer: 'return=minimal' });
      ok(res, {});
    } catch (e) { err(res, e.message); }
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
    await prepararToken(sb).catch(() => {});
    if (!igConfigurado()) return err(res, 'Instagram todavía no está conectado (falta IG_ACCESS_TOKEN en Render)', 501);
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado !== 'aprobado') return err(res, 'Solo se publican borradores aprobados', 400);
      ok(res, { borrador: await publicarBorrador(sb, b) });
    } catch (e) { err(res, e.message); }
  });

  // Publicación a mano (mientras Instagram no está conectado): se sube desde el celular y se marca acá
  app.post('/instagram/borradores/:id/marcar-publicado', requiereClave, async (req, res) => {
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'Borrador no encontrado', 404);
      if (b.estado !== 'aprobado') return err(res, 'Primero hay que aprobarlo', 400);
      const ahora = new Date().toISOString();
      const [actualizado] = await sb('PATCH', `publicaciones_borrador?id=eq.${encodeURIComponent(b.id)}`, {
        body: { estado: 'publicado', publicado_at: ahora, updated_at: ahora, error: null },
        prefer: 'return=representation',
      });
      ok(res, { borrador: actualizado });
    } catch (e) { err(res, e.message); }
  });

  // Estado de la conexión con Instagram (para el botón "Probar conexión")
  app.get('/instagram/conexion', async (req, res) => {
    try {
      await prepararToken(sb);
      if (!igConfigurado()) return ok(res, { conectado: false, motivo: 'Falta cargar IG_ACCESS_TOKEN en Render' });
      const cuenta = await cuentaIG();
      const t = await leerConfig(sb, 'instagram_token');
      ok(res, { conectado: true, usuario: cuenta.usuario, tipo: esTokenInstagram(ig.token) ? 'instagram' : 'facebook', vence: t?.base === ig.base ? t.vence || null : null });
    } catch (e) { ok(res, { conectado: false, motivo: e.message }); }
  });

  // --- Agenda ---

  app.get('/instagram/agenda', async (req, res) => {
    try {
      const agenda = await leerAgenda(sb);
      await prepararToken(sb).catch(() => {});
      ok(res, { agenda, ig_conectado: igConfigurado(), proximos: proximosSlots(agenda, new Date(), 14).map((f) => f.toISOString()) });
    } catch (e) { err(res, e.message); }
  });

  app.put('/instagram/agenda', requiereClave, async (req, res) => {
    try {
      const agenda = validarAgenda(req.body);
      await guardarConfig(sb, 'instagram_agenda', agenda);
      ok(res, { agenda });
    } catch (e) { err(res, e.message, 400); }
  });

  app.post('/instagram/agenda/generar-semana', requiereClave, async (req, res) => {
    if (estado.generando) return err(res, 'Hay otra publicación procesándose, probá en un rato', 409);
    estado.generando = true;
    try { ok(res, await generarSemana(sb, llamarClaude)); }
    catch (e) { err(res, e.message); }
    finally { estado.generando = false; }
  });

  const tick = () => cicloAgenda(sb, llamarClaude, estado);
  if (process.env.IG_AGENDA !== 'off') {
    setTimeout(tick, 60e3).unref();
    setInterval(tick, 5 * 60e3).unref();
  }
};

// Exportado para pruebas
module.exports.candidatos = candidatos;
module.exports.promptProductoUnico = promptProductoUnico;
module.exports.parsearJson = parsearJson;
module.exports.extraerSlides = extraerSlides;
module.exports.completarPlantilla = completarPlantilla;
module.exports.proximosSlots = proximosSlots;
module.exports.partesAR = partesAR;
module.exports.cicloAgenda = cicloAgenda;
