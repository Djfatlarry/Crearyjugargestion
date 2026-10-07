// tiendanube-reconciliacion.js
//
// Módulo de reconciliación de catálogo Tiendanube <-> Supabase (paso 1: EMPAREJAMIENTO).
//
// Cómo integrarlo en server.js:
//   1. Guardá este archivo en la raíz del repo, junto a server.js.
//   2. Cerca de arriba de server.js, donde están los otros 'require', agregá:
//        const registrarReconciliacionTiendanube = require('./tiendanube-reconciliacion');
//   3. DESPUÉS de que 'sb' ya esté definida (o sea, después de la función async function sb(...) {...}),
//      agregá esta línea (puede ir justo antes de "const PORT = process.env.PORT..."):
//        registrarReconciliacionTiendanube(app, sb);
//
// No hace falta ninguna librería nueva ni tocar el resto de server.js.

 const TN_BASE = 'https://api.tiendanube.com/v1';

function tnHeaders() {
  return {
    'Authentication': `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
    'User-Agent': 'CrearYJugarGestion (soporte@crearyjugar.com.ar)',
    'Content-Type': 'application/json',
  };
}

// --- Utilidades de matching de texto ---

function normalizarTexto(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarCodigo(s) {
  return (s || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function tokenizar(s) {
  return new Set(normalizarTexto(s).split(' ').filter(Boolean));
}

// Similitud Jaccard sobre tokens (0 a 1)
function similitudNombres(a, b) {
  const ta = tokenizar(a);
  const tb = tokenizar(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let interseccion = 0;
  for (const t of ta) if (tb.has(t)) interseccion++;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = interseccion / union;
  // Coincidencia parcial: el nombre más corto está casi todo dentro del más largo (ej. "Xilofón" vs "Xilofón De Madera 5 Notas").
  // Tope de 0.8: nunca llega a vínculo automático, siempre pasa por revisión manual.
  const contenido = interseccion >= 2 ? 0.8 * (interseccion / Math.min(ta.size, tb.size)) : 0;
  return Math.max(jaccard, contenido);
}

// Umbrales de confianza
const UMBRAL_AUTO = 0.85;    // arriba de esto: vínculo automático
const UMBRAL_REVISION = 0.5; // entre este y UMBRAL_AUTO: cola de revisión manual

// --- Llamada a la API de Tiendanube ---

async function traerProductosTiendanube() {
  const storeId = process.env.TIENDANUBE_STORE_ID;
  let productos = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const url = `${TN_BASE}/${storeId}/products?per_page=${perPage}&page=${page}`;
    const resp = await fetch(url, { headers: tnHeaders() });
    if (!resp.ok) {
      const texto = await resp.text();
      throw new Error(`Error Tiendanube API (${resp.status}): ${texto}`);
    }
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) break;
    productos = productos.concat(data);
    if (data.length < perPage) break;
    page++;
  }
  return productos;
}

function extraerSku(productoTN) {
  const variantes = productoTN.variants || [];
  const variante = variantes.find(v => v.sku && v.sku.trim() !== '');
  return variante ? variante.sku : null;
}

function extraerNombre(productoTN) {
  if (typeof productoTN.name === 'string') return productoTN.name;
  return (productoTN.name && (productoTN.name.es || Object.values(productoTN.name)[0])) || '';
}

function extraerDescripcion(productoTN) {
  if (typeof productoTN.description === 'string') return productoTN.description;
  return (productoTN.description && (productoTN.description.es || Object.values(productoTN.description)[0])) || '';
}

function extraerImagenes(productoTN) {
  return (productoTN.images || []).map(img => img.src).filter(Boolean);
}

// --- Registro de endpoints ---
// `sb` es la misma función helper que ya existe en server.js: sb(method, table, opts)

module.exports = function registrarReconciliacionTiendanube(app, sb) {

  function ok(res, data) { res.json({ ok: true, ...data }); }
  function err(res, msg, status = 500) { res.status(status).json({ ok: false, error: msg }); }

  // 1a. Solo traer y previsualizar los productos de Tiendanube (para chequear la conexión)
  app.get('/api/tiendanube/productos', async (req, res) => {
    try {
      const productos = await traerProductosTiendanube();
      ok(res, {
        total: productos.length,
        productos: productos.map(p => ({
          id: p.id,
          nombre: extraerNombre(p),
          sku: extraerSku(p),
        })),
      });
    } catch (e) { err(res, e.message); }
  });

  // 1a-bis. Lo mismo que /productos pero con precio, foto, link y stock (para la herramienta de vinculación)
  app.get('/api/tiendanube/productos-detalle', async (req, res) => {
    try {
      const productos = await traerProductosTiendanube();
      ok(res, {
        total: productos.length,
        productos: productos.map(t => {
          const v = (t.variants && t.variants[0]) || {};
          const vars = t.variants || [];
          const conNumero = vars.filter(x => x.stock !== null && x.stock !== undefined);
          return {
            id: t.id,
            // Stock de toda la publicación en la tienda (suma de variantes). "ilimitado" = alguna variante sin control de stock.
            stock_total: conNumero.reduce((a, x) => a + (Number(x.stock) || 0), 0),
            ilimitado: vars.some(x => x.stock === null || x.stock === undefined),
            nombre: extraerNombre(t),
            sku: extraerSku(t),
            precio: Number(v.price) > 0 ? Number(v.price) : null,
            precio_promo: Number(v.promotional_price) > 0 ? Number(v.promotional_price) : null,
            stock: v.stock === undefined ? null : v.stock,
            variantes: (t.variants || []).length,
            url: t.canonical_url || null,
            foto: (t.images && t.images[0] && t.images[0].src) || null,
            publicado: t.published !== false,
          };
        }),
      });
    } catch (e) { err(res, e.message); }
  });

  // 1b. Correr el emparejamiento real contra Supabase
  app.post('/api/tiendanube/reconciliar', async (req, res) => {
    try {
      const umbralRevision = Number(req.query.umbral) || UMBRAL_REVISION;
      const productosTN = await traerProductosTiendanube();

      const proveedores = await sb('GET', 'proveedores', {
        select: 'id,nombre,codigo,tiendanube_product_id,stock',
        limit: 5000,
      });

      // Productos de Tiendanube que ya pasaron por la cola (pendientes, confirmados o rechazados): no se vuelven a procesar
      const colaPrevia = await sb('GET', 'tiendanube_matches_pendientes', { select: 'tiendanube_product_id', limit: 5000 });
      const yaEnCola = new Set((colaPrevia || []).map(r => Number(r.tiendanube_product_id)));

      const porCodigo = new Map();
      for (const p of proveedores) {
        const cod = normalizarCodigo(p.codigo);
        if (cod) porCodigo.set(cod, p);
      }

      const yaVinculados = new Set(
        proveedores.filter(p => p.tiendanube_product_id).map(p => p.tiendanube_product_id)
      );

      const resumen = { auto_vinculados: 0, a_revision: 0, sin_match: 0, ya_vinculados: 0, ya_revisados_antes: 0, vinculados_sin_stock_en_app: 0 };

      for (const prodTN of productosTN) {
        if (yaVinculados.has(prodTN.id)) {
          resumen.ya_vinculados++;
          continue;
        }
        if (yaEnCola.has(Number(prodTN.id))) {
          resumen.ya_revisados_antes++;
          continue;
        }

        const nombreTN = extraerNombre(prodTN);
        const skuTN = normalizarCodigo(extraerSku(prodTN));

        let candidato = skuTN ? porCodigo.get(skuTN) : null;
        let confianza = candidato ? 1.0 : 0;
        let origen = candidato ? 'sku' : null;

        if (!candidato) {
          let mejor = null;
          let mejorScore = 0;
          for (const p of proveedores) {
            if (p.tiendanube_product_id) continue;
            const score = similitudNombres(nombreTN, p.nombre);
            if (score > mejorScore) {
              mejorScore = score;
              mejor = p;
            }
          }
          if (mejor && mejorScore >= umbralRevision) {
            candidato = mejor;
            confianza = mejorScore;
            origen = 'nombre';
          }
        }

        if (!candidato) {
          resumen.sin_match++;
          continue;
        }

        if (confianza >= UMBRAL_AUTO) {
          await sb('PATCH', `proveedores?id=eq.${candidato.id}`, {
            body: {
              tiendanube_product_id: prodTN.id,
              tiendanube_variant_id: (prodTN.variants && prodTN.variants[0]) ? prodTN.variants[0].id : null,
              match_confianza: confianza,
              match_origen: origen,
              updated_at: new Date().toISOString(),
            },
            prefer: 'return=minimal',
          });
          resumen.auto_vinculados++;
          if (!candidato.stock || Number(candidato.stock) <= 0) resumen.vinculados_sin_stock_en_app++;
        } else {
          await sb('POST', 'tiendanube_matches_pendientes', {
            body: {
              proveedor_id: candidato.id,
              tiendanube_product_id: prodTN.id,
              tiendanube_nombre: nombreTN,
              proveedor_nombre: candidato.nombre,
              confianza,
              tiendanube_data: prodTN,
              estado: 'pendiente',
            },
            prefer: 'return=minimal',
          });
          resumen.a_revision++;
        }
      }

      ok(res, { resumen });
    } catch (e) { err(res, e.message); }
  });

  // 1b-bis. Importar a la app los productos que existen SOLO en Tiendanube.
  // - Por defecto es una simulación (no escribe nada). Para aplicar: ?aplicar=1
  // - Entran con stock vacío ("sin cargar"): el stock se carga en la app y de ahí se sincroniza hacia la tienda.
  // - Se saltean los que están vinculados o esperando revisión en la cola.
  app.post('/api/tiendanube/importar', async (req, res) => {
    try {
      const aplicar = req.query.aplicar === '1';
      const GRUPOS_EDAD = { '0-2': '0 a 2 años', '3-5': '3 a 5 años', '6-8': '6 a 8 años', '9-12': '9 a 12 años', 'adolescentes': 'Adolescentes' };
      const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const nombreCat = (c) => (c && c.name && (c.name.es || Object.values(c.name)[0])) || (typeof c.name === 'string' ? c.name : '') || '';
      const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

      const productosTN = await traerProductosTiendanube();
      const vinc = await sb('GET', 'proveedores', { filter: 'tiendanube_product_id=not.is.null', select: 'tiendanube_product_id', limit: 5000 });
      const cola = await sb('GET', 'tiendanube_matches_pendientes', { filter: 'estado=eq.pendiente', select: 'tiendanube_product_id', limit: 5000 });
      const excluidos = new Set([...(vinc || []), ...(cola || [])].map(r => Number(r.tiendanube_product_id)));

      const filas = [];
      const variantesMultiples = [];
      const ahora = new Date().toISOString();
      for (const t of productosTN) {
        if (excluidos.has(Number(t.id))) continue;
        const variantes = t.variants || [];
        const v = variantes[0] || {};
        if (variantes.length > 1) variantesMultiples.push(extraerNombre(t));
        const cats = (t.categories || []).map(nombreCat).filter(Boolean);
        const gruposEdad = Object.entries(GRUPOS_EDAD).filter(([, nombre]) => cats.some(c => norm(c) === norm(nombre))).map(([k]) => k);
        const principal = cats.find(c => norm(c) !== norm('Por edad') && !Object.values(GRUPOS_EDAD).some(n => norm(n) === norm(c))) || null;
        const precio = num(v.price);
        filas.push({
          id: `TN-${t.id}`,
          proveedor: 'Tiendanube (importado)',
          codigo: (v.sku || '').trim(),
          nombre: extraerNombre(t),
          precio_costo: null,
          precio_publico: precio,
          precio_venta: precio,
          categoria: '',
          categoria_sugerida: principal,
          edad_grupos: gruposEdad,
          descripcion: extraerDescripcion(t) || null,
          imagenes: extraerImagenes(t),
          tags: (t.tags || '').trim() || null,
          peso: num(v.weight), ancho: num(v.width), alto: num(v.height), profundidad: num(v.depth),
          stock: null,
          tiendanube_product_id: t.id,
          tiendanube_variant_id: v.id || null,
          match_confianza: 1,
          match_origen: 'importado',
          validado: false,
          manual: false,
          updated_at: ahora,
        });
      }

      let importados = 0;
      if (aplicar) {
        for (let i = 0; i < filas.length; i += 50) {
          await sb('POST', 'proveedores', { body: filas.slice(i, i + 50), prefer: 'resolution=ignore-duplicates,return=minimal' });
          importados += Math.min(50, filas.length - i);
        }
      }
      ok(res, {
        simulacion: !aplicar,
        a_importar: filas.length,
        importados,
        omitidos_vinculados_o_en_cola: excluidos.size,
        con_variantes_multiples: variantesMultiples,
        sin_precio: filas.filter(f => !f.precio_venta).length,
        sin_foto: filas.filter(f => !f.imagenes.length).length,
        sin_descripcion: filas.filter(f => !f.descripcion).length,
        sin_categoria: filas.filter(f => !f.categoria_sugerida).length,
        ejemplo: filas.slice(0, 3).map(f => ({ id: f.id, nombre: f.nombre, precio_venta: f.precio_venta, categoria_sugerida: f.categoria_sugerida, edad_grupos: f.edad_grupos, fotos: f.imagenes.length })),
      });
    } catch (e) { err(res, e.message); }
  });

  // 1c. Ver la cola de revisión manual
  app.get('/api/tiendanube/pendientes', async (req, res) => {
    try {
      const d = await sb('GET', 'tiendanube_matches_pendientes', {
        filter: 'estado=eq.pendiente',
        order: 'confianza.desc',
      });
      ok(res, { pendientes: d || [] });
    } catch (e) { err(res, e.message); }
  });

  // 1d. Confirmar un match dudoso -> vincula de verdad en proveedores
  app.post('/api/tiendanube/pendientes/:id/confirmar', async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await sb('GET', `tiendanube_matches_pendientes?id=eq.${id}`, {});
      const pendiente = rows && rows[0];
      if (!pendiente) return err(res, 'No encontrado', 404);

      await sb('PATCH', `proveedores?id=eq.${pendiente.proveedor_id}`, {
        body: {
          tiendanube_product_id: pendiente.tiendanube_product_id,
          tiendanube_variant_id: (pendiente.tiendanube_data && pendiente.tiendanube_data.variants && pendiente.tiendanube_data.variants[0]) ? pendiente.tiendanube_data.variants[0].id : null,
          match_confianza: pendiente.confianza,
          match_origen: 'manual',
          updated_at: new Date().toISOString(),
        },
        prefer: 'return=minimal',
      });

      await sb('PATCH', `tiendanube_matches_pendientes?id=eq.${id}`, {
        body: { estado: 'confirmado', resuelto_at: new Date().toISOString() },
        prefer: 'return=minimal',
      });

      ok(res, {});
    } catch (e) { err(res, e.message); }
  });

  // 1e. Rechazar un match dudoso
  app.post('/api/tiendanube/pendientes/:id/rechazar', async (req, res) => {
    try {
      const { id } = req.params;
      await sb('PATCH', `tiendanube_matches_pendientes?id=eq.${id}`, {
        body: { estado: 'rechazado', resuelto_at: new Date().toISOString() },
        prefer: 'return=minimal',
      });
      ok(res, {});
    } catch (e) { err(res, e.message); }
  });
};
