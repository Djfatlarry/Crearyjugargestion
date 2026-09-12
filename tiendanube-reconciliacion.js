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

 const TN_BASE = 'https://api.tiendanube.com/v1';';

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
  return interseccion / union;
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

  // 1b. Correr el emparejamiento real contra Supabase
  app.post('/api/tiendanube/reconciliar', async (req, res) => {
    try {
      const productosTN = await traerProductosTiendanube();

      const proveedores = await sb('GET', 'proveedores', {
        select: 'id,nombre,codigo,tiendanube_product_id',
        limit: 5000,
      });

      const porCodigo = new Map();
      for (const p of proveedores) {
        const cod = normalizarCodigo(p.codigo);
        if (cod) porCodigo.set(cod, p);
      }

      const yaVinculados = new Set(
        proveedores.filter(p => p.tiendanube_product_id).map(p => p.tiendanube_product_id)
      );

      const resumen = { auto_vinculados: 0, a_revision: 0, sin_match: 0, ya_vinculados: 0 };

      for (const prodTN of productosTN) {
        if (yaVinculados.has(prodTN.id)) {
          resumen.ya_vinculados++;
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
          if (mejor && mejorScore >= UMBRAL_REVISION) {
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
              match_confianza: confianza,
              match_origen: origen,
              updated_at: new Date().toISOString(),
            },
            prefer: 'return=minimal',
          });
          resumen.auto_vinculados++;
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
