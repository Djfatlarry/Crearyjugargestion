aconst express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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
  };
  if (opts.select) url += `?select=${opts.select}`;
  if (opts.filter) url += (url.includes('?') ? '&' : '?') + opts.filter;
  if (opts.order) url += (url.includes('?') ? '&' : '?') + `order=${opts.order}`;
  if (opts.limit) url += (url.includes('?') ? '&' : '?') + `limit=${opts.limit}`;
  const res = await fetch(url, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) { const t = await res.text(); throw new Error(`Supabase ${method} ${table}: ${res.status} ${t}`); }
  if (res.status === 204) return null;
  return res.json();
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
    let imported = 0;
    for (let i = 0; i < ventas.length; i += 100) {
      await sb('POST', 'ventas', { body: ventas.slice(i, i+100), prefer: 'resolution=ignore-duplicates,return=minimal' });
      imported += Math.min(100, ventas.length - i);
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
    const d = await sb('GET', 'proveedores', { select: 'proveedor' });
    const provs = [...new Set((d || []).map(p => p.proveedor))].sort();
    ok(res, { proveedores: provs });
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

// ADMIN
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CYJ backend v3.0 (Supabase) en puerto ${PORT}`));
