const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ─── JSON FILE STORAGE ───────────────────────────────────────────────────────
const DB_DIR = process.env.DB_PATH || './data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

function dbPath(name) { return path.join(DB_DIR, name + '.json'); }

function read(name) {
  try {
    const p = dbPath(name);
    if (!fs.existsSync(p)) return name === 'precio_log' ? [] : {};
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) { return name === 'precio_log' ? [] : {}; }
}

function write(name, data) {
  fs.writeFileSync(dbPath(name), JSON.stringify(data, null, 2), 'utf8');
}

// ─── LOAD INITIAL CATALOG FROM BUNDLED JSON ──────────────────────────────────
const CATALOG_SOURCE = path.join(__dirname, 'proveedores_catalogo.json');
function initCatalog() {
  const catalogPath = dbPath('proveedores');
  if (!fs.existsSync(catalogPath) && fs.existsSync(CATALOG_SOURCE)) {
    const raw = JSON.parse(fs.readFileSync(CATALOG_SOURCE, 'utf8'));
    // Add validado field and id
    const withMeta = raw.map((p, i) => ({
      id: `PROV-${String(i+1).padStart(5,'0')}`,
      ...p,
      validado: false,
      precio_venta: p.precio_publico,
      updated_at: new Date().toISOString()
    }));
    write('proveedores', withMeta);
    console.log(`Catálogo inicializado: ${withMeta.length} productos`);
  }
}
initCatalog();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function ok(res, data) { res.json({ ok: true, ...data }); }
function err(res, msg, status = 500) { res.status(status).json({ ok: false, error: msg }); }

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, version: '2.0.0' }));

// ─── VENTAS ──────────────────────────────────────────────────────────────────
app.get('/ventas', (_, res) => {
  const store = read('ventas');
  const ventas = (Array.isArray(store) ? store : Object.values(store))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  ok(res, { ventas });
});

app.post('/ventas', (req, res) => {
  const v = req.body;
  if (!v?.id || !v?.fecha) return err(res, 'Datos inválidos', 400);
  try {
    let store = read('ventas');
    if (Array.isArray(store)) {
      if (!store.find(x => x.id === v.id)) store.push(v);
    } else {
      store[v.id] = v;
    }
    write('ventas', store);
    ok(res, { id: v.id });
  } catch (e) { err(res, e.message); }
});

app.post('/ventas/bulk', (req, res) => {
  const { ventas } = req.body;
  if (!Array.isArray(ventas)) return err(res, 'Se esperaba array', 400);
  try {
    let store = read('ventas');
    let count = 0;
    if (Array.isArray(store)) {
      const ids = new Set(store.map(x => x.id));
      ventas.forEach(v => { if (!ids.has(v.id)) { store.push(v); count++; } });
    } else {
      ventas.forEach(v => { if (!store[v.id]) { store[v.id] = v; count++; } });
    }
    write('ventas', store);
    ok(res, { imported: count });
  } catch (e) { err(res, e.message); }
});

app.delete('/ventas/:id', (req, res) => {
  let store = read('ventas');
  if (Array.isArray(store)) store = store.filter(x => x.id !== req.params.id);
  else delete store[req.params.id];
  write('ventas', store);
  ok(res, {});
});

// ─── GASTOS ──────────────────────────────────────────────────────────────────
app.get('/gastos', (_, res) => {
  const store = read('gastos');
  const gastos = (Array.isArray(store) ? store : Object.values(store))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  ok(res, { gastos });
});

app.post('/gastos', (req, res) => {
  const g = req.body;
  if (!g?.id || !g?.fecha) return err(res, 'Datos inválidos', 400);
  try {
    let store = read('gastos');
    if (Array.isArray(store)) {
      if (!store.find(x => x.id === g.id)) store.push(g);
    } else { store[g.id] = g; }
    write('gastos', store);
    ok(res, { id: g.id });
  } catch (e) { err(res, e.message); }
});

app.post('/gastos/bulk', (req, res) => {
  const { gastos } = req.body;
  if (!Array.isArray(gastos)) return err(res, 'Se esperaba array', 400);
  try {
    let store = read('gastos');
    let count = 0;
    if (Array.isArray(store)) {
      const ids = new Set(store.map(x => x.id));
      gastos.forEach(g => { if (!ids.has(g.id)) { store.push(g); count++; } });
    } else {
      gastos.forEach(g => { if (!store[g.id]) { store[g.id] = g; count++; } });
    }
    write('gastos', store);
    ok(res, { imported: count });
  } catch (e) { err(res, e.message); }
});

app.delete('/gastos/:id', (req, res) => {
  let store = read('gastos');
  if (Array.isArray(store)) store = store.filter(x => x.id !== req.params.id);
  else delete store[req.params.id];
  write('gastos', store);
  ok(res, {});
});

// ─── CONFIG ──────────────────────────────────────────────────────────────────
app.get('/config', (_, res) => {
  const config = read('config');
  ok(res, { config });
});

app.post('/config', (req, res) => {
  const { key, value } = req.body;
  if (!key) return err(res, 'key requerido', 400);
  const config = read('config');
  config[key] = value;
  write('config', config);
  ok(res, { key });
});

app.post('/config/bulk', (req, res) => {
  const { config: incoming } = req.body;
  if (!incoming) return err(res, 'config requerido', 400);
  const config = read('config');
  Object.assign(config, incoming);
  write('config', config);
  ok(res, { saved: Object.keys(incoming).length });
});

// ─── PROVEEDORES / CATÁLOGO ───────────────────────────────────────────────────
app.get('/proveedores', (req, res) => {
  const store = read('proveedores');
  const list = Array.isArray(store) ? store : Object.values(store);
  const { proveedor, validado, q } = req.query;
  let filtered = list;
  if (proveedor) filtered = filtered.filter(p => p.proveedor === proveedor);
  if (validado !== undefined) filtered = filtered.filter(p => p.validado === (validado === 'true'));
  if (q) {
    const ql = q.toLowerCase();
    filtered = filtered.filter(p => p.nombre?.toLowerCase().includes(ql) || p.codigo?.toLowerCase().includes(ql));
  }
  ok(res, { productos: filtered, total: list.length });
});

app.get('/proveedores/list', (_, res) => {
  const store = read('proveedores');
  const list = Array.isArray(store) ? store : Object.values(store);
  const provs = [...new Set(list.map(p => p.proveedor))].sort();
  ok(res, { proveedores: provs });
});

app.patch('/proveedores/:id', (req, res) => {
  const { id } = req.params;
  const changes = req.body;
  const store = read('proveedores');
  const list = Array.isArray(store) ? store : Object.values(store);
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return err(res, 'Producto no encontrado', 404);
  const prev = list[idx];
  list[idx] = { ...prev, ...changes, updated_at: new Date().toISOString() };
  // Log price change if precio_venta changed
  if (changes.precio_venta && changes.precio_venta !== prev.precio_venta) {
    const log = read('precio_log');
    const logArr = Array.isArray(log) ? log : [];
    logArr.unshift({
      producto_id: id, nombre: prev.nombre,
      precio_anterior: prev.precio_venta, precio_nuevo: changes.precio_venta,
      fecha: new Date().toISOString()
    });
    write('precio_log', logArr.slice(0, 500));
  }
  write('proveedores', list);
  ok(res, { producto: list[idx] });
});

app.post('/proveedores/upload', (req, res) => {
  // Accept array of new products from uploaded list
  const { productos, proveedor } = req.body;
  if (!Array.isArray(productos)) return err(res, 'Se esperaba array de productos', 400);
  const store = read('proveedores');
  const list = Array.isArray(store) ? store : Object.values(store);
  let added = 0, updated = 0;
  productos.forEach(p => {
    const existing = list.find(x => x.proveedor === (proveedor || p.proveedor) && x.nombre === p.nombre);
    if (existing) {
      Object.assign(existing, { ...p, validado: false, updated_at: new Date().toISOString() });
      updated++;
    } else {
      list.push({
        id: `PROV-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        ...p, validado: false, precio_venta: p.precio_publico,
        updated_at: new Date().toISOString()
      });
      added++;
    }
  });
  write('proveedores', list);
  ok(res, { added, updated });
});

app.get('/proveedores/precio-log', (_, res) => {
  const log = read('precio_log');
  ok(res, { log: (Array.isArray(log) ? log : []).slice(0, 200) });
});

// ─── COSTOS FIJOS ────────────────────────────────────────────────────────────
app.get('/costos-fijos', (_, res) => {
  const config = read('config');
  ok(res, { costos: config.costos_fijos || [] });
});

app.post('/costos-fijos', (req, res) => {
  const { costos } = req.body;
  if (!Array.isArray(costos)) return err(res, 'Se esperaba array', 400);
  const config = read('config');
  config.costos_fijos = costos;
  write('config', config);
  ok(res, { saved: costos.length });
});

// ─── DATOS BACKEND (resumen para admin) ──────────────────────────────────────
app.get('/admin/summary', (_, res) => {
  const ventas = read('ventas');
  const gastos = read('gastos');
  const provs = read('proveedores');
  const vList = Array.isArray(ventas) ? ventas : Object.values(ventas);
  const gList = Array.isArray(gastos) ? gastos : Object.values(gastos);
  const pList = Array.isArray(provs) ? provs : Object.values(provs);
  ok(res, {
    ventas: { total: vList.length, historicas: vList.filter(v => v.historico).length, nuevas: vList.filter(v => !v.historico).length },
    gastos: { total: gList.length },
    proveedores: { total: pList.length, validados: pList.filter(p => p.validado).length, pendientes: pList.filter(p => !p.validado).length },
  });
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CYJ backend v2.0 corriendo en puerto ${PORT}`));
