// estudio.js
//
// "Estudio Crear y Jugar": asistente de contenido para María Elena (y Carlos y Pablo).
// Es una capa conversacional sobre el agente de Instagram (instagram-agente.js): no duplica su
// lógica, la usa a través de sus propias rutas /instagram/* (llamadas internas con IG_ADMIN_KEY).
//
// Rutas (todas piden el header x-admin-key, igual que las del agente):
//   GET  /estudio/inicio?usuario=Nombre   saludo del día, calendario de hoy y lo pendiente
//   POST /estudio/chat                    { usuario, mensajes: [{ role, content }] } -> { texto, tarjetas }
//   POST /estudio/piezas/:id/aprobar      aprueba y, si no tiene fecha, la agenda en el próximo horario libre
//   POST /estudio/piezas/:id/cambios      { pedido } -> edición por chat del borrador
//   DELETE /estudio/piezas/:id            descarta el borrador
//   GET  /estudio/marca                   guía de marca + calendario (config 'estudio_marca')
//   PUT  /estudio/marca                   la reemplaza (pantalla de Pablo)
//
// No usa tablas nuevas: la guía de marca vive en la tabla config y las publicaciones en
// publicaciones_borrador (las del agente). El historial del chat lo guarda la app en el dispositivo.
//
// Variables de entorno: las del backend (ANTHROPIC_API_KEY, IG_ADMIN_KEY, PORT) y opcionales
//   ESTUDIO_MODELO   default 'claude-sonnet-5-5'
//   ESTUDIO_API_URL  default 'https://api.anthropic.com/v1/messages' (se cambia solo para pruebas)

const crypto = require('crypto');

const MODELO = process.env.ESTUDIO_MODELO || 'claude-sonnet-5-5';
const API_URL = process.env.ESTUDIO_API_URL || 'https://api.anthropic.com/v1/messages';
const MAX_VUELTAS = 6;

const DIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

// Guía de marca inicial (se puede editar desde la app; esto es solo el punto de partida)
const MARCA_DEFAULT = {
  nombre: 'Crear y Jugar Didáctica',
  filosofia: 'Juguetería didáctica con 24 años en Olivos. Juguetes que promueven el estímulo temprano y el aprendizaje a través del juego, con enfoque Montessori.',
  tono: 'Cálido, cercano y rioplatense (vos). Educativo sin ser técnico. Le habla a madres, padres, abuelos y docentes.',
  evitar: ['Prometer resultados terapéuticos o de salud', 'Precios sin confirmar', 'Personajes o marcas de terceros que no vendemos'],
  datos: {
    direccion: 'Ricardo Gutiérrez 1215, Olivos',
    instagram: '@crearyjugardidacticos',
    tienda: 'crearyjugar.mitiendanube.com',
    horario: 'Lunes a sábado desde las 9:30',
    pagos: '15% de descuento pagando por transferencia',
  },
  colores: { lavanda: '#8B80B6', crema: '#F3EAE0', coral: '#F28C6B', turquesa: '#6EC5C9', amarillo: '#F7D46B', verde: '#A0CD82', rosa: '#E878AA', tinta: '#4A3E78' },
  hashtags: ['#crearyjugar', '#juguetesdidacticos', '#olivos'],
  calendario: {
    1: { feed: 'Reel didáctico o creativo', historias: 'Subir el reel + encuesta "¿Ya conocías este juego?" (fondo template 6)' },
    2: { feed: 'Post de producto destacando beneficios didácticos (template 1)', historias: 'Subir el post + trivia verdadero o falso sobre el producto (template 6)' },
    3: { feed: 'Post sobre la juguetería: horarios, medios de pago, historia, valores, enfoque didáctico (template 2)', historias: 'Encuesta "¿Ya pasaste por el local a conocernos?" (template 6) o mapa con ubicación (template 5)' },
    4: { feed: 'Post de ofertas o promos: productos en descuento (template 3)', historias: '"Oferta del mes" + link a la web + mapa (template 5)' },
    5: { feed: 'Post sobre la web: categorías o novedades online (template 4)', historias: 'Subir el post + link al sitio ("entraron productos nuevos a la web")' },
    6: { feed: 'Post de horarios y dirección (template 2 o 5)', historias: 'Mapa + "¡Te esperamos hoy!" + sticker de ubicación (template 5)' },
    7: { feed: 'Post de ofertas o promos (template 3)', historias: '"Oferta del mes" + sticker de cuenta regresiva + link a la web' },
  },
};

function partesAR(fecha = new Date()) {
  const d = new Date(fecha.getTime() - 3 * 3600e3);
  return { ymd: d.toISOString().slice(0, 10), dow: d.getUTCDay() || 7, hora: d.getUTCHours() };
}

function fechaLegible(iso) {
  if (!iso) return null;
  const d = new Date(new Date(iso).getTime() - 3 * 3600e3);
  const dow = d.getUTCDay() || 7;
  return `${DIAS[dow]} ${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function nombreSaludo(usuario) {
  return String(usuario || '').trim().slice(0, 40);
}

// Para el saludo: sin las referencias internas a las plantillas ("(template 3)")
function sinPlantilla(texto) {
  return String(texto || '').replace(/\s*\(templates?[^)]*\)/gi, '').trim();
}

// Resumen liviano de un borrador para el modelo (sin HTML ni historial)
function resumenBorrador(b) {
  return {
    id: b.id,
    tipo: b.tipo,
    estado: b.estado,
    programado_para: fechaLegible(b.programado_para),
    caption: String(b.caption || '').slice(0, 220),
    slides: (b.slides || []).length,
    error: b.error || undefined,
  };
}

// Lo que ve la app en cada tarjeta
function tarjeta(b) {
  return {
    id: b.id,
    tipo: b.tipo,
    estado: b.estado,
    caption: b.caption || '',
    slides: b.slides || [],
    programado_para: b.programado_para || null,
    programado_legible: fechaLegible(b.programado_para),
    error: b.error || null,
  };
}

function promptSistema(marca, usuario, ahora = new Date()) {
  const { ymd, dow } = partesAR(ahora);
  const hoy = marca.calendario?.[dow] || {};
  return `Sos el asistente de contenido de ${marca.nombre}, una juguetería didáctica familiar. Tu nombre es "Estudio Crear y Jugar".
Hablás con ${usuario || 'alguien de la familia'}. Hoy es ${DIAS[dow]} ${ymd} (hora de Argentina).

Cómo hablás:
- Español rioplatense, con "vos", cálido y simple. Frases cortas. Nada técnico (no digas "API", "borrador en la base", "endpoint").
- Respuestas breves: 2 a 6 líneas, salvo cuando armás un guion o una lista de tomas.
- Si algo no se puede hacer todavía, decilo en una línea y ofrecé lo que sí se puede.

La marca:
- Filosofía: ${marca.filosofia}
- Tono: ${marca.tono}
- Evitar: ${(marca.evitar || []).join('; ')}
- Datos: ${Object.entries(marca.datos || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
- Hashtags base: ${(marca.hashtags || []).join(' ')}

Calendario de hoy (${DIAS[dow]}): feed = ${hoy.feed || 'libre'}; historias = ${hoy.historias || 'libre'}.

Qué podés hacer con tus herramientas:
- Ver el calendario de cualquier día, las publicaciones pendientes y la agenda de horarios.
- Buscar productos del catálogo con stock y fotos.
- Crear publicaciones de feed: "unico" (carrusel de un producto), "multi" (varios productos con una idea en común) o "institucional" (imagen sobre el local, sin producto). Tardan cerca de un minuto: avisá antes de crearlas.
- Editar una publicación con un pedido en palabras simples.
- Armar las publicaciones de toda la semana según la agenda.

Reglas:
- Nunca se publica nada sin aprobación. Aprobar, descartar o pedir cambios lo hace la persona con los botones en "Para aprobar"; vos no aprobás.
- Los colores y fondos de las publicaciones ya varían solos de una a otra; si te piden otros colores, usá editar_publicacion.
- Cuando crees o edites una publicación, queda en la sección "Para aprobar" de la app (la persona ve un aviso con un botón para ir): no repitas el texto completo, contá en una línea qué hiciste y decile que la revise en Para aprobar.
- Antes de crear algo, si el pedido es claro hacelo; si es ambiguo, hacé una sola pregunta corta.
- Reels y videos todavía no se editan acá (llega en la próxima etapa). Para un reel de producto o de promo: proponé el producto, un gancho de 2 palabras y una lista de 4 a 6 tomas con duración ("la caja de cerca, 3 segundos"). Para un video institucional: 3 o 4 ideas para decir con sus palabras y la lista de tomas, pensando en que Pablo filma todo junto el día 1 de cada mes.
- Las historias: describí la imagen y qué sticker poner (encuesta, trivia, ubicación o link); se suben a mano desde Instagram.
- Ideas: proponé 3, cortas, mezclando calendario, temporada (fechas especiales cercanas) y productos con stock.`;
}

const HERRAMIENTAS = [
  {
    name: 'ver_calendario',
    description: 'Devuelve qué toca publicar en el feed y en historias un día de la semana (1 = lunes ... 7 = domingo). Sin día, devuelve la semana entera.',
    input_schema: { type: 'object', properties: { dia: { type: 'integer', minimum: 1, maximum: 7 } } },
  },
  {
    name: 'ver_publicaciones',
    description: 'Lista publicaciones del feed. estado: "borrador" (esperan aprobación), "aprobado" (programadas) o "publicado". Con mostrar=true la persona las ve como tarjetas.',
    input_schema: {
      type: 'object',
      properties: {
        estado: { type: 'string', enum: ['borrador', 'aprobado', 'publicado'] },
        mostrar: { type: 'boolean' },
      },
    },
  },
  {
    name: 'ver_agenda',
    description: 'Días y horarios en que se publica el feed y las próximas fechas libres u ocupadas.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'buscar_productos',
    description: 'Busca productos del catálogo con stock y fotos por nombre o categoría. Sin texto, devuelve los que hace más que no se publican.',
    input_schema: { type: 'object', properties: { texto: { type: 'string' }, limite: { type: 'integer', minimum: 1, maximum: 15 } } },
  },
  {
    name: 'crear_publicacion',
    description: 'Crea una publicación de feed lista para aprobar (tarda cerca de un minuto). tipo "unico" usa producto_id o elige solo; "multi" e "institucional" usan idea.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['unico', 'multi', 'institucional'] },
        producto_id: { type: 'string' },
        idea: { type: 'string', description: 'Idea o tema en pocas palabras (máximo 300 caracteres)' },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'editar_publicacion',
    description: 'Cambia una publicación existente según un pedido en palabras simples ("más alegre", "sacá el precio").',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, pedido: { type: 'string' } }, required: ['id', 'pedido'] },
  },
  {
    name: 'armar_semana',
    description: 'Crea las publicaciones de los próximos 7 días según la agenda (solo para fechas que todavía no tienen una). Tarda varios minutos.',
    input_schema: { type: 'object', properties: {} },
  },
];

module.exports = function registrarEstudio(app, sb, { puerto } = {}) {
  const ok = (res, data) => res.json({ ok: true, ...data });
  const err = (res, msg, status = 500) => res.status(status).json({ ok: false, error: msg });

  const requiereClave = (req, res, next) => {
    const clave = process.env.IG_ADMIN_KEY;
    if (!clave) return err(res, 'Falta configurar IG_ADMIN_KEY en el servidor', 503);
    const enviada = Buffer.from(String(req.get('x-admin-key') || ''));
    const esperada = Buffer.from(clave);
    if (enviada.length !== esperada.length || !crypto.timingSafeEqual(enviada, esperada)) return err(res, 'Clave inválida', 401);
    next();
  };

  // Llamada a las rutas del agente de Instagram en este mismo servidor
  async function interno(metodo, ruta, body) {
    const r = await fetch(`http://127.0.0.1:${puerto}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.IG_ADMIN_KEY || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }

  async function leerMarca() {
    const guardada = (await sb('GET', 'config', { filter: 'key=eq.estudio_marca' }))?.[0]?.value;
    return { ...MARCA_DEFAULT, ...(guardada || {}), calendario: { ...MARCA_DEFAULT.calendario, ...(guardada?.calendario || {}) } };
  }

  async function borradores(estado) {
    const filtro = estado ? `estado=eq.${encodeURIComponent(estado)}` : undefined;
    return (await sb('GET', 'publicaciones_borrador', { filter: filtro, order: 'created_at.desc', limit: 30 })) || [];
  }

  async function buscarBorrador(id) {
    return (await sb('GET', 'publicaciones_borrador', { filter: `id=eq.${encodeURIComponent(id)}` }))?.[0];
  }

  // Próximo horario de la agenda que no tenga ya una publicación asignada
  async function proximoLibre() {
    const { proximos = [] } = await interno('GET', '/instagram/agenda');
    const ocupados = await sb('GET', 'publicaciones_borrador', { select: 'programado_para', filter: `programado_para=gte.${new Date().toISOString()}` });
    const tomados = new Set((ocupados || []).map((o) => new Date(o.programado_para).getTime()));
    return proximos.find((f) => !tomados.has(new Date(f).getTime())) || null;
  }

  // Ejecuta una herramienta. Devuelve { resultado, tarjetas: [ids] }
  async function ejecutar(nombre, input, marca) {
    switch (nombre) {
      case 'ver_calendario': {
        if (input.dia) return { resultado: { dia: DIAS[input.dia], ...marca.calendario[input.dia] } };
        return { resultado: Object.entries(marca.calendario).map(([d, v]) => ({ dia: DIAS[d], ...v })) };
      }
      case 'ver_publicaciones': {
        const lista = await borradores(input.estado);
        return { resultado: lista.map(resumenBorrador), tarjetas: input.mostrar ? lista.slice(0, 8).map((b) => b.id) : [] };
      }
      case 'ver_agenda': {
        const a = await interno('GET', '/instagram/agenda');
        return {
          resultado: {
            horarios: (a.agenda?.slots || []).map((s) => `${DIAS[s.dia]} ${s.hora}`),
            proximos: (a.proximos || []).slice(0, 8).map(fechaLegible),
            instagram_conectado: !!a.ig_conectado,
          },
        };
      }
      case 'buscar_productos': {
        const limite = Math.min(input.limite || 8, 15);
        const texto = String(input.texto || '').trim();
        let lista;
        if (texto) {
          const q = encodeURIComponent(`*${texto.replace(/[*,()]/g, ' ')}*`);
          lista = await sb('GET', 'proveedores', {
            select: 'id,nombre,categoria,stock,imagenes',
            filter: `stock=gt.0&imagenes=not.is.null&or=(nombre.ilike.${q},categoria.ilike.${q},categoria_grande.ilike.${q})`,
            limit: limite - 1,
          });
        } else {
          lista = (await interno('GET', `/instagram/candidatos?n=${limite}`)).candidatos;
        }
        return {
          resultado: (lista || []).slice(0, limite).map((p) => ({
            id: p.id, nombre: p.nombre, categoria: p.categoria, stock: p.stock,
            fotos: Array.isArray(p.imagenes) ? p.imagenes.length : p.fotos,
            ultima_publicacion: p.ultima_publicacion,
          })),
        };
      }
      case 'crear_publicacion': {
        const { borrador } = await interno('POST', '/instagram/generar', {
          tipo: input.tipo, producto_id: input.producto_id, idea: input.idea,
        });
        return { resultado: resumenBorrador(borrador), tarjetas: [borrador.id] };
      }
      case 'editar_publicacion': {
        const { borrador, respuesta } = await interno('POST', `/instagram/borradores/${encodeURIComponent(input.id)}/editar`, { mensaje: input.pedido });
        return { resultado: { ...resumenBorrador(borrador), respuesta_del_editor: respuesta }, tarjetas: [borrador.id] };
      }
      case 'armar_semana': {
        const r = await interno('POST', '/instagram/agenda/generar-semana');
        return { resultado: { creadas: r.creados?.length || 0, errores: r.errores || [] }, tarjetas: (r.creados || []).map((c) => c.id) };
      }
      default:
        throw new Error(`Herramienta desconocida: ${nombre}`);
    }
  }

  async function llamarModelo(body) {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Error llamando a la IA: ${r.status} ${await r.text()}`);
    return r.json();
  }

  // --- Rutas ---

  app.get('/estudio/inicio', requiereClave, async (req, res) => {
    try {
      const marca = await leerMarca();
      const { dow, hora } = partesAR();
      const nombre = nombreSaludo(req.query.usuario);
      const hoy = marca.calendario[dow] || {};
      const feedHoy = sinPlantilla(hoy.feed);
      const [pendientes, aprobados] = await Promise.all([borradores('borrador'), borradores('aprobado')]);
      const momento = hora < 13 ? 'Buenos días' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
      let saludo = `${momento}${nombre ? ` ${nombre}` : ''}. Hoy es ${DIAS[dow]}: en el feed toca ${feedHoy ? feedHoy.charAt(0).toLowerCase() + feedHoy.slice(1) : 'lo que quieras'}.`;
      if (pendientes.length) saludo += ` Tenés ${pendientes.length === 1 ? 'una publicación' : `${pendientes.length} publicaciones`} esperando tu aprobación.`;
      saludo += ' ¿Qué creamos hoy?';
      ok(res, {
        saludo,
        hoy: { dia: DIAS[dow], ...hoy },
        pendientes: pendientes.slice(0, 8).map(tarjeta),
        programados: aprobados
          .filter((b) => b.programado_para)
          .sort((a, b) => new Date(a.programado_para) - new Date(b.programado_para))
          .slice(0, 6)
          .map(tarjeta),
      });
    } catch (e) { err(res, e.message); }
  });

  app.post('/estudio/chat', requiereClave, async (req, res) => {
    const usuario = String(req.body?.usuario || '').slice(0, 40);
    const entrada = Array.isArray(req.body?.mensajes) ? req.body.mensajes : [];
    // Solo texto y solo los últimos turnos: el historial completo lo guarda la app
    const mensajes = entrada
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    while (mensajes.length && mensajes[0].role !== 'user') mensajes.shift();
    if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') return err(res, 'Falta el mensaje', 400);

    try {
      const marca = await leerMarca();
      const system = promptSistema(marca, usuario);
      const idsTarjetas = [];
      let texto = '';
      for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
        const r = await llamarModelo({ model: MODELO, max_tokens: 1500, system, tools: HERRAMIENTAS, messages: mensajes });
        const bloques = r.content || [];
        texto = bloques.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (r.stop_reason !== 'tool_use') break;
        mensajes.push({ role: 'assistant', content: bloques });
        const resultados = [];
        for (const b of bloques.filter((x) => x.type === 'tool_use')) {
          try {
            const { resultado, tarjetas = [] } = await ejecutar(b.name, b.input || {}, marca);
            idsTarjetas.push(...tarjetas);
            resultados.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(resultado) });
          } catch (e) {
            resultados.push({ type: 'tool_result', tool_use_id: b.id, content: `No se pudo: ${e.message}`, is_error: true });
          }
        }
        mensajes.push({ role: 'user', content: resultados });
      }
      const unicos = [...new Set(idsTarjetas)];
      const tarjetas = (await Promise.all(unicos.map(buscarBorrador))).filter(Boolean).map(tarjeta);
      ok(res, { texto: texto || 'Listo.', tarjetas });
    } catch (e) { err(res, e.message); }
  });

  app.post('/estudio/piezas/:id/aprobar', requiereClave, async (req, res) => {
    try {
      const b = await buscarBorrador(req.params.id);
      if (!b) return err(res, 'No encontré esa publicación', 404);
      if (b.estado === 'publicado') return err(res, 'Ya está publicada', 400);
      const cambios = { estado: 'aprobado' };
      if (!b.programado_para || new Date(b.programado_para) < new Date()) {
        const libre = await proximoLibre();
        if (libre) cambios.programado_para = libre;
      }
      const { borrador } = await interno('PATCH', `/instagram/borradores/${encodeURIComponent(b.id)}`, cambios);
      const { ig_conectado } = await interno('GET', '/instagram/agenda').catch(() => ({}));
      ok(res, { tarjeta: tarjeta(borrador), instagram_conectado: !!ig_conectado });
    } catch (e) { err(res, e.message); }
  });

  app.post('/estudio/piezas/:id/cambios', requiereClave, async (req, res) => {
    const pedido = String(req.body?.pedido || '').trim();
    if (!pedido) return err(res, 'Contame qué querés cambiar', 400);
    try {
      const { borrador, respuesta } = await interno('POST', `/instagram/borradores/${encodeURIComponent(req.params.id)}/editar`, { mensaje: pedido.slice(0, 1000) });
      ok(res, { tarjeta: tarjeta(borrador), respuesta });
    } catch (e) { err(res, e.message); }
  });

  app.delete('/estudio/piezas/:id', requiereClave, async (req, res) => {
    try {
      await interno('DELETE', `/instagram/borradores/${encodeURIComponent(req.params.id)}`);
      ok(res, {});
    } catch (e) { err(res, e.message); }
  });

  app.get('/estudio/marca', requiereClave, async (req, res) => {
    try { ok(res, { marca: await leerMarca() }); }
    catch (e) { err(res, e.message); }
  });

  app.put('/estudio/marca', requiereClave, async (req, res) => {
    const marca = req.body?.marca;
    if (!marca || typeof marca !== 'object' || Array.isArray(marca)) return err(res, 'Guía de marca inválida', 400);
    if (JSON.stringify(marca).length > 30000) return err(res, 'La guía de marca es demasiado larga', 400);
    try {
      await sb('POST', 'config', { body: { key: 'estudio_marca', value: marca, updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
      ok(res, { marca: await leerMarca() });
    } catch (e) { err(res, e.message); }
  });
};

// Exportado para pruebas
module.exports.promptSistema = promptSistema;
module.exports.MARCA_DEFAULT = MARCA_DEFAULT;
module.exports.HERRAMIENTAS = HERRAMIENTAS;
module.exports.fechaLegible = fechaLegible;
