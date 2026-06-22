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
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return {}; }
}

function write(name, data) {
  fs.writeFileSync(dbPath(name), JSON.stringify(data, null, 2), 'utf8');
}

// Initialize stores
['ventas', 'gastos', 'config', 'catalogo', 'precio_log'].forEach(name => {
  if (!fs.existsSync(dbPath(name))) {
    write(name, name === 'precio_log' ? [] : {});
  }
});

// ─── HELPERS ────────────────────────────────────────────────────────────────
function ok(res, data) { res.json({ ok: true, ...data }); }
function err(res, msg, status = 500) { res.status(status).json({ ok: false, error: msg }); }

// ─── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, version: '1.0.0' }));

// ─── VENTAS ─────────────────────────────────────────────────────────────────
app.get('/ventas', (_, res) => {
  const store = read('ventas');
  const ventas = Object.values(store).sort((a, b) => a.fecha.localeCompare(b.fecha));
  ok(res, { ventas });
});

app.post('/ventas', (req, res) => {
  const v = req.body;
  if (!v || !v.id || !v.fecha) return err(res, 'Datos inválidos', 400);
  try {
    const store = read('ventas');
    store[v.id] = v;
    write('ventas', store);
    ok(res, { id: v.id });
  } catch (e) { err(res, e.message); }
});

app.post('/ventas/bulk', (req, res) => {
  const { ventas } = req.body;
  if (!Array.isArray(ventas)) return err(res, 'Se esperaba array', 400);
  try {
    const store = read('ventas');
    let count = 0;
    ventas.forEach(v => {
      if (!store[v.id]) { store[v.id] = v; count++; }
    });
    write('ventas', store);
    ok(res, { imported: count });
  } catch (e) { err(res, e.message); }
});

app.delete('/ventas/:id', (req, res) => {
  const store = read('ventas');
  delete store[req.params.id];
  write('ventas', store);
  ok(res, {});
});

// ─── GASTOS ─────────────────────────────────────────────────────────────────
app.get('/gastos', (_, res) => {
  const store = read('gastos');
  const gastos = Object.values(store).sort((a, b) => a.fecha.localeCompare(b.fecha));
  ok(res, { gastos });
});

app.post('/gastos', (req, res) => {
  const g = req.body;
  if (!g || !g.id || !g.fecha) return err(res, 'Datos inválidos', 400);
  try {
    const store = read('gastos');
    store[g.id] = g;
    write('gastos', store);
    ok(res, { id: g.id });
  } catch (e) { err(res, e.message); }
});

app.post('/gastos/bulk', (req, res) => {
  const { gastos } = req.body;
  if (!Array.isArray(gastos)) return err(res, 'Se esperaba array', 400);
  try {
    const store = read('gastos');
    let count = 0;
    gastos.forEach(g => {
      if (!store[g.id]) { store[g.id] = g; count++; }
    });
    write('gastos', store);
    ok(res, { imported: count });
  } catch (e) { err(res, e.message); }
});

app.delete('/gastos/:id', (req, res) => {
  const store = read('gastos');
  delete store[req.params.id];
  write('gastos', store);
  ok(res, {});
});

// ─── CONFIG ─────────────────────────────────────────────────────────────────
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

// ─── CATÁLOGO (precios custom) ───────────────────────────────────────────────
app.get('/catalogo', (_, res) => {
  const catalogo = read('catalogo');
  ok(res, { catalogo: Object.values(catalogo) });
});

app.post('/catalogo/:producto_id/precio', (req, res) => {
  const { producto_id } = req.params;
  const { precio_venta, precio_lista, proveedor, nombre, precio_anterior } = req.body;
  const now = new Date().toISOString();

  // Log the change
  const log = read('precio_log');
  if (!Array.isArray(log)) write('precio_log', []);
  const logArr = Array.isArray(log) ? log : [];
  logArr.unshift({ producto_id, nombre: nombre || producto_id, precio_anterior: precio_anterior || 0, precio_nuevo: precio_venta, fecha: now });
  write('precio_log', logArr.slice(0, 500));

  // Upsert catalog entry
  const catalogo = read('catalogo');
  catalogo[producto_id] = { producto_id, precio_venta, precio_lista: precio_lista || null, proveedor: proveedor || null, updated_at: now };
  write('catalogo', catalogo);

  ok(res, { producto_id, precio_venta });
});

app.get('/catalogo/precio-log', (_, res) => {
  const log = read('precio_log');
  ok(res, { log: Array.isArray(log) ? log.slice(0, 200) : [] });
});

// ─── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CYJ backend corriendo en puerto ${PORT}`));
