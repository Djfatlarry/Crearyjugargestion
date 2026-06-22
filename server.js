const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// SQLite database — persists in Railway volume or local filesystem
const DB_DIR = process.env.DB_PATH || './data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'cyj.db'));

// ─── SCHEMA ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ventas (
    id TEXT PRIMARY KEY,
    fecha TEXT NOT NULL,
    items TEXT NOT NULL,
    subtotal REAL,
    descuento_pct REAL,
    total REAL,
    medio_pago TEXT,
    impuesto_pct REAL,
    neto_estimado REAL,
    historico INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS gastos (
    id TEXT PRIMARY KEY,
    fecha TEXT NOT NULL,
    descripcion TEXT,
    categoria TEXT,
    monto REAL,
    historico INTEGER DEFAULT 0,
    fijo INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS precio_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id TEXT,
    nombre TEXT,
    precio_anterior REAL,
    precio_nuevo REAL,
    fecha TEXT,
    usuario TEXT DEFAULT 'admin'
  );

  CREATE TABLE IF NOT EXISTS catalogo_custom (
    producto_id TEXT PRIMARY KEY,
    precio_venta REAL,
    precio_lista REAL,
    proveedor TEXT,
    updated_at TEXT
  );
`);

// ─── HELPERS ────────────────────────────────────────────────────────────────
function ok(res, data) { res.json({ ok: true, ...data }); }
function err(res, msg, status = 500) { res.status(status).json({ ok: false, error: msg }); }

// ─── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, version: '1.0.0' }));

// ─── VENTAS ─────────────────────────────────────────────────────────────────
app.get('/ventas', (_, res) => {
  const rows = db.prepare('SELECT * FROM ventas ORDER BY fecha ASC').all();
  rows.forEach(r => r.items = JSON.parse(r.items));
  ok(res, { ventas: rows });
});

app.post('/ventas', (req, res) => {
  const v = req.body;
  if (!v || !v.id || !v.fecha) return err(res, 'Datos inválidos', 400);
  try {
    db.prepare(`INSERT OR REPLACE INTO ventas
      (id, fecha, items, subtotal, descuento_pct, total, medio_pago, impuesto_pct, neto_estimado, historico)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(v.id, v.fecha, JSON.stringify(v.items), v.subtotal, v.descuento_pct, v.total,
           v.medio_pago, v.impuesto_pct || 0, v.neto_estimado || 0, v.historico ? 1 : 0);
    ok(res, { id: v.id });
  } catch (e) { err(res, e.message); }
});

// Bulk import historical sales
app.post('/ventas/bulk', (req, res) => {
  const { ventas } = req.body;
  if (!Array.isArray(ventas)) return err(res, 'Se esperaba array', 400);
  const insert = db.prepare(`INSERT OR IGNORE INTO ventas
    (id, fecha, items, subtotal, descuento_pct, total, medio_pago, impuesto_pct, neto_estimado, historico)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMany = db.transaction(vs => {
    vs.forEach(v => insert.run(v.id, v.fecha, JSON.stringify(v.items),
      v.subtotal, v.descuento_pct, v.total, v.medio_pago,
      v.impuesto_pct || 0, v.neto_estimado || 0, v.historico ? 1 : 0));
  });
  insertMany(ventas);
  ok(res, { imported: ventas.length });
});

app.delete('/ventas/:id', (req, res) => {
  db.prepare('DELETE FROM ventas WHERE id = ?').run(req.params.id);
  ok(res, {});
});

// ─── GASTOS ─────────────────────────────────────────────────────────────────
app.get('/gastos', (_, res) => {
  const rows = db.prepare('SELECT * FROM gastos ORDER BY fecha ASC').all();
  ok(res, { gastos: rows });
});

app.post('/gastos', (req, res) => {
  const g = req.body;
  if (!g || !g.id || !g.fecha) return err(res, 'Datos inválidos', 400);
  try {
    db.prepare(`INSERT OR REPLACE INTO gastos (id, fecha, descripcion, categoria, monto, historico, fijo)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(g.id, g.fecha, g.descripcion, g.categoria, g.monto, g.historico ? 1 : 0, g.fijo ? 1 : 0);
    ok(res, { id: g.id });
  } catch (e) { err(res, e.message); }
});

app.post('/gastos/bulk', (req, res) => {
  const { gastos } = req.body;
  if (!Array.isArray(gastos)) return err(res, 'Se esperaba array', 400);
  const insert = db.prepare(`INSERT OR IGNORE INTO gastos (id, fecha, descripcion, categoria, monto, historico, fijo)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertMany = db.transaction(gs => {
    gs.forEach(g => insert.run(g.id, g.fecha, g.descripcion, g.categoria, g.monto,
      g.historico ? 1 : 0, g.fijo ? 1 : 0));
  });
  insertMany(gastos);
  ok(res, { imported: gastos.length });
});

app.delete('/gastos/:id', (req, res) => {
  db.prepare('DELETE FROM gastos WHERE id = ?').run(req.params.id);
  ok(res, {});
});

// ─── CONFIG ─────────────────────────────────────────────────────────────────
app.get('/config', (_, res) => {
  const rows = db.prepare('SELECT key, value, updated_at FROM config').all();
  const config = {};
  rows.forEach(r => { try { config[r.key] = JSON.parse(r.value); } catch { config[r.key] = r.value; } });
  ok(res, { config });
});

app.post('/config', (req, res) => {
  const { key, value } = req.body;
  if (!key) return err(res, 'key requerido', 400);
  const now = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, JSON.stringify(value), now);
  ok(res, { key });
});

app.post('/config/bulk', (req, res) => {
  const { config } = req.body;
  if (!config) return err(res, 'config requerido', 400);
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)');
  const insertMany = db.transaction(entries => {
    entries.forEach(([k, v]) => insert.run(k, JSON.stringify(v), now));
  });
  insertMany(Object.entries(config));
  ok(res, { saved: Object.keys(config).length });
});

// ─── CATÁLOGO (precios custom) ────────────────────────────────────────────
app.get('/catalogo', (_, res) => {
  const rows = db.prepare('SELECT * FROM catalogo_custom').all();
  ok(res, { catalogo: rows });
});

app.post('/catalogo/:producto_id/precio', (req, res) => {
  const { producto_id } = req.params;
  const { precio_venta, precio_lista, proveedor, nombre, precio_anterior } = req.body;
  const now = new Date().toISOString();

  // Log the change
  db.prepare(`INSERT INTO precio_log (producto_id, nombre, precio_anterior, precio_nuevo, fecha)
    VALUES (?, ?, ?, ?, ?)`)
    .run(producto_id, nombre || producto_id, precio_anterior || 0, precio_venta, now);

  // Upsert catalog entry
  db.prepare(`INSERT OR REPLACE INTO catalogo_custom (producto_id, precio_venta, precio_lista, proveedor, updated_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(producto_id, precio_venta, precio_lista || null, proveedor || null, now);

  ok(res, { producto_id, precio_venta });
});

app.get('/catalogo/precio-log', (_, res) => {
  const rows = db.prepare('SELECT * FROM precio_log ORDER BY fecha DESC LIMIT 200').all();
  ok(res, { log: rows });
});

// ─── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CYJ backend corriendo en puerto ${PORT}`));
