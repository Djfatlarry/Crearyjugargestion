const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const registrarReconciliacionTiendanube = require('./tiendanube-reconciliacion');
const registrarAuthTiendanube = require('./auth-tiendanube');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } }); // 40MB, algunas listas traen imágenes incrustadas

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sb(method, table, opts = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': opts.prefer || '',
    'Range-Unit': 'items',
    'Range': `0-${opts.limit || 9999}`,
  };
  if (opts.select) url += `?select=${opts.select}`;
  if (opts.filter) url += (url.includes('?') ? '&' : '?') + opts.filter;
  if (opts.order) url += (url.includes('?') ? '&' : '?') + `order=${opts.order}`;
  const res = await fetch(url, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok && res.status !== 206) { const t = await res.text(); throw new Error(`Supabase ${method} ${table}: ${res.status} ${t}`); }
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function ok(res, data) { res.json({ ok: true, ...data }); }
function err(res, msg, status = 500) { res.status(status).json({ ok: false, error: msg }); }

app.get('/health', (_, res) => res.json({ ok: true, version: '3.0.0', storage: 'supabase' }));

// VENTAS
app.get('/ventas', async (_, res) => {
  try { const d = await sb('GET', 'ventas', { order: 'fecha.asc' }); ok(res, { ventas: d || [] }); }
  catch (e) { err(res, e.message); }
});
app.post('/ventas', async (req, res) => {
  const v = req.body;
  if (!v?.id || !v?.fecha) return err(res, 'Datos inválidos', 400);
  try { await sb('POST', 'ventas', { body: v, prefer: 'resolution=ignore-duplicates,return=minimal' }); ok(res, { id: v.id }); }
  catch (e) { err(res, e.message); }
});
app.post('/ventas/bulk', async (req, res) => {
  const { ventas } = req.body;
  if (!Array.isArray(ventas)) return err(res, 'array esperado', 400);
  try {
    const normalized = ventas.map(v => ({
      ...v,
      items: typeof v.items === 'string' ? v.items : JSON.stringify(v.items)
    }));
    let imported = 0;
    for (let i = 0; i < normalized.length; i += 100) {
      await sb('POST', 'ventas', { body: normalized.slice(i, i+100), prefer: 'resolution=ignore-duplicates,return=minimal' });
      imported += Math.min(100, normalized.length - i);
    }
    ok(res, { imported });
  } catch (e) { err(res, e.message); }
});
app.delete('/ventas/:id', async (req, res) => {
  try { await sb('DELETE', `ventas?id=eq.${req.params.id}`); ok(res, {}); }
  catch (e) { err(res, e.message); }
});

// GASTOS
app.get('/gastos', async (req, res) => {
  try {
    let filter = req.query.mes ? `mes=eq.${req.query.mes}` : '';
    const d = await sb('GET', 'gastos', { order: 'fecha.asc', filter });
    ok(res, { gastos: d || [] });
  } catch (e) { err(res, e.message); }
});
app.post('/gastos', async (req, res) => {
  const g = req.body;
  if (!g?.id || !g?.fecha) return err(res, 'Datos inválidos', 400);
  try { await sb('POST', 'gastos', { body: g, prefer: 'resolution=ignore-duplicates,return=minimal' }); ok(res, { id: g.id }); }
  catch (e) { err(res, e.message); }
});
app.post('/gastos/bulk', async (req, res) => {
  const { gastos } = req.body;
  if (!Array.isArray(gastos)) return err(res, 'array esperado', 400);
  try {
    let imported = 0;
    for (let i = 0; i < gastos.length; i += 100) {
      await sb('POST', 'gastos', { body: gastos.slice(i, i+100), prefer: 'resolution=ignore-duplicates,return=minimal' });
      imported += Math.min(100, gastos.length - i);
    }
    ok(res, { imported });
  } catch (e) { err(res, e.message); }
});
app.patch('/gastos/:id', async (req, res) => {
  try { await sb('PATCH', `gastos?id=eq.${req.params.id}`, { body: req.body, prefer: 'return=minimal' }); ok(res, {}); }
  catch (e) { err(res, e.message); }
});
app.delete('/gastos/:id', async (req, res) => {
  try { await sb('DELETE', `gastos?id=eq.${req.params.id}`); ok(res, {}); }
  catch (e) { err(res, e.message); }
});

// CONFIG
app.get('/config', async (_, res) => {
  try {
    const d = await sb('GET', 'config');
    const config = {};
    (d || []).forEach(r => { config[r.key] = r.value; });
    ok(res, { config });
  } catch (e) { err(res, e.message); }
});
app.post('/config', async (req, res) => {
  const { key, value } = req.body;
  if (!key) return err(res, 'key requerido', 400);
  try { await sb('POST', 'config', { body: { key, value, updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' }); ok(res, { key }); }
  catch (e) { err(res, e.message); }
});
app.post('/config/bulk', async (req, res) => {
  const { config: inc } = req.body;
  if (!inc) return err(res, 'config requerido', 400);
  try {
    const now = new Date().toISOString();
    const rows = Object.entries(inc).map(([key, value]) => ({ key, value, updated_at: now }));
    await sb('POST', 'config', { body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
    ok(res, { saved: rows.length });
  } catch (e) { err(res, e.message); }
});

// PROVEEDORES
app.get('/proveedores', async (req, res) => {
  try {
    let filter = '';
    if (req.query.proveedor) filter += `proveedor=eq.${req.query.proveedor}&`;
    if (req.query.validado !== undefined) filter += `validado=eq.${req.query.validado}&`;
    if (req.query.q) filter += `nombre=ilike.*${encodeURIComponent(req.query.q)}*&`;
    if (filter.endsWith('&')) filter = filter.slice(0,-1);
    const d = await sb('GET', 'proveedores', { order: 'proveedor.asc,nombre.asc', filter, limit: req.query.limit || 200 });
    const all = await sb('GET', 'proveedores', { select: 'id' });
    ok(res, { productos: d || [], total: (all || []).length });
  } catch (e) { err(res, e.message); }
});
app.get('/proveedores/list', async (_, res) => {
  try {
    const d = await sb('GET', 'proveedores', { select: 'proveedor', limit: 5000 });
    const provs = [...new Set((d || []).map(p => p.proveedor))].filter(Boolean).sort();
    ok(res, { proveedores: provs });
  } catch (e) { err(res, e.message); }
});

// Elimina TODOS los productos de un proveedor (una lista completa)
app.delete('/proveedores/lista/:proveedor', async (req, res) => {
  try {
    const proveedorNombre = decodeURIComponent(req.params.proveedor);
    if (!proveedorNombre) return err(res, 'Falta el nombre del proveedor', 400);
    const existentes = await sb('GET', 'proveedores', { filter: `proveedor=eq.${encodeURIComponent(proveedorNombre)}`, select: 'id' });
    const cantidad = (existentes || []).length;
    if (!cantidad) return ok(res, { eliminados: 0, mensaje: 'No se encontraron productos de ese proveedor' });
    await sb('DELETE', `proveedores?proveedor=eq.${encodeURIComponent(proveedorNombre)}`);
    ok(res, { eliminados: cantidad, proveedor: proveedorNombre });
  } catch (e) { err(res, e.message); }
});
app.patch('/proveedores/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (req.body.precio_venta !== undefined) {
      const ex = await sb('GET', `proveedores?id=eq.${id}`, { select: 'nombre,precio_venta' });
      const prev = ex?.[0];
      if (prev && req.body.precio_venta !== prev.precio_venta) {
        await sb('POST', 'precio_log', { body: { producto_id: id, nombre: prev.nombre, precio_anterior: prev.precio_venta, precio_nuevo: req.body.precio_venta } });
      }
    }
    await sb('PATCH', `proveedores?id=eq.${id}`, { body: { ...req.body, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
    ok(res, {});
  } catch (e) { err(res, e.message); }
});
app.post('/proveedores/bulk', async (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos)) return err(res, 'array esperado', 400);
  try {
    let imported = 0;
    for (let i = 0; i < productos.length; i += 100) {
      await sb('POST', 'proveedores', { body: productos.slice(i, i+100), prefer: 'resolution=ignore-duplicates,return=minimal' });
      imported += Math.min(100, productos.length - i);
    }
    ok(res, { imported });
  } catch (e) { err(res, e.message); }
});
app.post('/proveedores/upsert', async (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos)) return err(res, 'array esperado', 400);
  try {
    let upserted = 0;
    for (let i = 0; i < productos.length; i += 100) {
      const batch = productos.slice(i, i+100).map(p => ({ ...p, updated_at: new Date().toISOString() }));
      await sb('POST', 'proveedores', { body: batch, prefer: 'resolution=merge-duplicates,return=minimal' });
      upserted += batch.length;
    }
    ok(res, { upserted });
  } catch (e) { err(res, e.message); }
});
app.get('/proveedores/precio-log', async (_, res) => {
  try { const d = await sb('GET', 'precio_log', { order: 'fecha.desc', limit: 200 }); ok(res, { log: d || [] }); }
  catch (e) { err(res, e.message); }
});

// PRODUCTOS PENDIENTES (manuales)
app.get('/productos-pendientes', async (_, res) => {
  try { const d = await sb('GET', 'productos_pendientes', { order: 'created_at.desc' }); ok(res, { productos: d || [] }); }
  catch (e) { err(res, e.message); }
});
app.post('/productos-pendientes', async (req, res) => {
  const p = req.body;
  if (!p?.id || !p?.nombre) return err(res, 'Datos inválidos', 400);
  try { await sb('POST', 'productos_pendientes', { body: p, prefer: 'resolution=ignore-duplicates,return=minimal' }); ok(res, { id: p.id }); }
  catch (e) { err(res, e.message); }
});
app.patch('/productos-pendientes/:id', async (req, res) => {
  try { await sb('PATCH', `productos_pendientes?id=eq.${req.params.id}`, { body: req.body, prefer: 'return=minimal' }); ok(res, {}); }
  catch (e) { err(res, e.message); }
});

// ─── CARGA INTELIGENTE DE LISTA DE PROVEEDOR (con IA) ────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.post('/proveedores/upload-excel', (req, res, next) => {
  upload.single('file')(req, res, (uploadErr) => {
    if (uploadErr) {
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return err(res, 'El archivo es demasiado grande (máximo 40MB). Si tiene fotos incrustadas, probá guardarlo como "Excel sin macros" o sacar imágenes innecesarias.', 400);
      }
      return err(res, 'Error recibiendo el archivo: ' + uploadErr.message, 400);
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return err(res, 'No se recibió ningún archivo', 400);
    const proveedorNombre = req.body.proveedor;
    if (!proveedorNombre) return err(res, 'Falta el nombre del proveedor', 400);
    if (!ANTHROPIC_API_KEY) return err(res, 'Falta configurar ANTHROPIC_API_KEY en el servidor', 500);

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    let bestRows = [];
    let bestSheet = workbook.SheetNames[0];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const nonEmpty = rows.filter(r => r.some(c => c !== '' && c !== null));
      if (nonEmpty.length > bestRows.length) {
        bestRows = nonEmpty;
        bestSheet = sheetName;
      }
    }
    const rows = bestRows;
    console.log(`Usando hoja: ${bestSheet} (${rows.length} filas con datos)`);

    if (!rows.length) return err(res, 'El archivo está vacío', 400);

    const nonEmptyRows = rows;

    const HEADER_KEYWORDS = ['codigo','cód','sku','art','artículo','articulo','nombre','producto','descripcion','descripción','detalle','titulo','título','precio','costo','público','publico','pvp','neto','lista','cantidad','stock','isbn'];
    function puntuarComoHeader(row) {
      let puntos = 0;
      for (const cell of row) {
        if (typeof cell !== 'string') continue;
        const c = cell.toLowerCase().trim();
        if (c.length > 0 && c.length < 40 && HEADER_KEYWORDS.some(k => c.includes(k))) puntos++;
      }
      return puntos;
    }
    let mejorFilaHeader = 0, mejorPuntaje = 0;
    nonEmptyRows.slice(0, 80).forEach((row, idx) => {
      const p = puntuarComoHeader(row);
      if (p > mejorPuntaje) { mejorPuntaje = p; mejorFilaHeader = idx; }
    });

    const inicioMuestra = mejorPuntaje >= 2 ? Math.max(0, mejorFilaHeader - 2) : 0;
    const sampleRows = nonEmptyRows.slice(inicioMuestra, inicioMuestra + 30);
    const sampleText = sampleRows.map((r, i) => `Fila ${inicioMuestra + i}: ${JSON.stringify(r)}`).join('\n');
    const pistaHeader = mejorPuntaje >= 2
      ? `\n\nPISTA: la fila ${mejorFilaHeader} parece contener los encabezados reales de la tabla (palabras como código/producto/precio). Es muy probable que fila_inicio sea ${mejorFilaHeader + 1} o muy cercano, salvo que veas evidencia clara de lo contrario.`
      : '';

    const prompt = `Sos un asistente experto en listas de precios de proveedores de jugueterías en Argentina. Analizá estas filas de un archivo Excel e identificá las columnas clave.

Filas del archivo (array de celdas, indexadas desde columna 0; el índice de fila es el real dentro del archivo, no empieza necesariamente en 0):
${sampleText}${pistaHeader}

REGLAS para identificar cada columna:
- NOMBRE del producto: buscá headers como "Descripción", "Artículo", "Producto", "Detalle", "Nombre", "Art.". Es la columna con TEXTO DESCRIPTIVO del juguete/producto. Suele ser la más larga en contenido.
- PRECIO COSTO (precio del proveedor, sin margen): buscá "Neto", "Precio Lista", "P. Costo", "Costo", "Precio s/IVA", "Lista", "Precio Neto", "P/Mayor", "Mayorista". Es el número MÁS BAJO entre las columnas de precios.
- PRECIO PÚBLICO (precio sugerido al consumidor): buscá "P. Público", "Público", "PVP", "Precio Público", "Precio Venta", "P.P.", "Precio Sugerido", "Minorista", "Consumidor Final". Es el número MÁS ALTO, generalmente entre 1.5x y 3x el precio de costo.
- CÓDIGO/SKU: buscá "Código", "Cód", "SKU", "Art.", "Ref", "Artículo" cuando hay OTRA columna separada con el nombre del producto. Si el código y el artículo están en la misma columna, devolvé null para código.
- fila_inicio: número de la primera fila con datos REALES de productos (saltando títulos, logos, headers vacíos, etc.). Contá desde 0.

IMPORTANTE: Si hay solo UNA columna de precios, es el precio público (los proveedores a veces solo informan precio público). Si hay DOS columnas numéricas similares, la menor es costo y la mayor es público.

Respondé ÚNICAMENTE con un JSON válido, sin texto adicional ni explicaciones:
{"fila_inicio": 0, "col_nombre": 0, "col_codigo": null, "col_costo": 0, "col_publico": null, "confianza": "alto"}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return err(res, `Error llamando a la IA: ${aiRes.status} ${t}`);
    }
    const aiData = await aiRes.json();
    const aiText = aiData.content?.[0]?.text || '';
    let mapping;
    try {
      let jsonStr = aiText.trim();
      const jsonMatch = aiText.match(/\{[\s\S]*?\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
      jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      try {
        mapping = JSON.parse(jsonStr);
      } catch(parseErr) {
        return err(res, `No se pudo parsear respuesta de IA. Respuesta recibida: ${aiText.slice(0,300)}`);
      }
    } catch (e) {
      return err(res, 'No se pudo interpretar la respuesta de la IA: ' + e.message);
    }

    const { fila_inicio, col_nombre, col_codigo, col_costo, col_publico, confianza } = mapping;
    const necesitaRevision = confianza !== 'alto';

    const productos = [];
    for (let i = fila_inicio; i < nonEmptyRows.length; i++) {
      const row = nonEmptyRows[i];
      const nombre = col_nombre !== null && row[col_nombre] ? String(row[col_nombre]).trim() : '';
      if (!nombre || nombre.length < 2) continue;
      const parseNum = (v) => {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'number') return v;
        const s = String(v).replace(/[^0-9.,]/g, '').replace(',', '.');
        const n = parseFloat(s);
        return isNaN(n) ? null : n;
      };
      const costo = col_costo !== null ? parseNum(row[col_costo]) : null;
      const publico = col_publico !== null ? parseNum(row[col_publico]) : null;
      if (!costo && !publico) continue;
      productos.push({
        proveedor: proveedorNombre,
        codigo: col_codigo !== null ? String(row[col_codigo] || '').trim() : '',
        nombre,
        precio_costo: costo,
        precio_publico: publico || (costo ? Math.round(costo * 2.2) : null),
        precio_venta: publico || (costo ? Math.round(costo * 2.2) : null),
        categoria: '',
      });
    }

    if (!productos.length) {
      return err(res, 'No se pudieron extraer productos. Revisá el formato del archivo o probá con otra hoja.');
    }

    const precios = productos.map(p => p.precio_publico || p.precio_costo || 0).filter(p => p > 0 && p < 10000);
    if (precios.length > 0) {
      const sorted = [...precios].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median < 500) {
        console.log(`Precios en miles detectados (mediana: ${median}), multiplicando x1000`);
        productos.forEach(p => {
          if (p.precio_costo && p.precio_costo < 2000) p.precio_costo = Math.round(p.precio_costo * 1000);
          if (p.precio_publico && p.precio_publico < 2000) p.precio_publico = Math.round(p.precio_publico * 1000);
          if (p.precio_venta && p.precio_venta < 2000) p.precio_venta = Math.round(p.precio_venta * 1000);
        });
      }
    }

    const normalizar = (s) => (s || '')
      .toString()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const existing = await sb('GET', 'proveedores', { filter: `proveedor=eq.${encodeURIComponent(proveedorNombre)}`, select: 'id,nombre,codigo', limit: 5000 });
    const existingPorCodigo = {};
    const existingPorNombre = {};
    (existing || []).forEach(p => {
      if (p.codigo && p.codigo.trim()) existingPorCodigo[p.codigo.trim().toLowerCase()] = p.id;
      existingPorNombre[normalizar(p.nombre)] = p.id;
    });

    let added = 0, updated = 0;
    const toInsert = [];
    const toUpdate = [];
    productos.forEach(p => {
      const codigoKey = p.codigo && p.codigo.trim() ? p.codigo.trim().toLowerCase() : null;
      const nombreKey = normalizar(p.nombre);
      const idExistente = (codigoKey && existingPorCodigo[codigoKey]) || existingPorNombre[nombreKey];
      if (idExistente) {
        toUpdate.push({ id: idExistente, ...p, validado: necesitaRevision ? false : undefined, updated_at: new Date().toISOString() });
        updated++;
      } else {
        toInsert.push({ id: `PROV-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, ...p, validado: false, manual: false, updated_at: new Date().toISOString() });
        added++;
      }
    });

    if (toInsert.length) {
      for (let i = 0; i < toInsert.length; i += 100) {
        await sb('POST', 'proveedores', { body: toInsert.slice(i, i+100), prefer: 'resolution=ignore-duplicates,return=minimal' });
      }
    }

    let actualizadosOk = 0;
    const erroresActualizacion = [];
    const LOTE_ACTUALIZACION = 20;
    for (let i = 0; i < toUpdate.length; i += LOTE_ACTUALIZACION) {
      const lote = toUpdate.slice(i, i + LOTE_ACTUALIZACION);
      const resultados = await Promise.allSettled(lote.map(u => {
        const { id, ...changes } = u;
        return sb('PATCH', `proveedores?id=eq.${id}`, { body: changes, prefer: 'return=minimal' })
          .then(() => ({ id, nombre: changes.nombre }));
      }));
      resultados.forEach((r, idx) => {
        const { id, nombre } = lote[idx];
        if (r.status === 'fulfilled') actualizadosOk++;
        else erroresActualizacion.push({ id, nombre, error: r.reason?.message || 'error desconocido' });
      });
    }

    ok(res, {
      added, updated, actualizados_ok: actualizadosOk,
      errores_actualizacion: erroresActualizacion,
      total: productos.length,
      confianza, necesita_revision: necesitaRevision,
      mapping_usado: mapping,
    });
  } catch (e) {
    err(res, 'Error procesando archivo: ' + e.message);
  }
});


app.get('/admin/summary', async (_, res) => {
  try {
    const [v, g, p, pend] = await Promise.all([
      sb('GET', 'ventas', { select: 'id,historico' }),
      sb('GET', 'gastos', { select: 'id' }),
      sb('GET', 'proveedores', { select: 'id,validado' }),
      sb('GET', 'productos_pendientes', { select: 'id,confirmado' }),
    ]);
    ok(res, {
      ventas: { total: (v||[]).length, historicas: (v||[]).filter(x=>x.historico).length, nuevas: (v||[]).filter(x=>!x.historico).length },
      gastos: { total: (g||[]).length },
      proveedores: { total: (p||[]).length, validados: (p||[]).filter(x=>x.validado).length, pendientes: (p||[]).filter(x=>!x.validado).length },
      productos_pendientes: { total: (pend||[]).length },
    });
  } catch (e) { err(res, e.message); }
});

app.post('/admin/reload-catalog', async (_, res) => {
  try {
    const SRC = path.join(__dirname, 'proveedores_catalogo.json');
    if (!fs.existsSync(SRC)) return err(res, 'proveedores_catalogo.json no encontrado');
    const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    const withMeta = raw.map((p, i) => ({
      id: `PROV-${String(i+1).padStart(5,'0')}`,
      ...p, validado: false, precio_venta: p.precio_publico,
      updated_at: new Date().toISOString()
    }));
    let loaded = 0;
    for (let i = 0; i < withMeta.length; i += 100) {
      await sb('POST', 'proveedores', { body: withMeta.slice(i, i+100), prefer: 'resolution=ignore-duplicates,return=minimal' });
      loaded += Math.min(100, withMeta.length - i);
    }
    ok(res, { reloaded: loaded });
  } catch (e) { err(res, e.message); }
});

registrarReconciliacionTiendanube(app, sb);
registrarAuthTiendanube(app);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CYJ backend v3.0 (Supabase) en puerto ${PORT}`));
