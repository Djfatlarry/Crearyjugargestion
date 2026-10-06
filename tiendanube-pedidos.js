// tiendanube-pedidos.js
//
// Ventas online de Tiendanube -> app.
//   - Cuando un pedido se PAGA en la tienda: se registra como venta ("Tienda Nube") y se descuenta el stock de la app.
//   - Cuando un pedido se CANCELA: si ya estaba registrado, se borra esa venta y se devuelve el stock.
//
// Cómo se conecta en server.js:
//   const registrarPedidosTiendanube = require('./tiendanube-pedidos');
//   registrarPedidosTiendanube(app, { sb, tn, empujarStockTn });
//
// Uso (una sola vez, después de desplegar):
//   POST /api/tiendanube/webhooks/registrar     -> le dice a Tiendanube que avise de pedidos pagados/cancelados
// Utilidades:
//   GET  /api/tiendanube/pedidos/ultimos         -> últimos pedidos de la tienda (sirve para chequear permisos)
//   POST /api/tiendanube/pedidos/procesar/:id    -> simula (o con ?aplicar=1 registra) un pedido puntual

const crypto = require('crypto');

module.exports = function registrarPedidosTiendanube(app, { sb, tn, empujarStockTn }) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const ok = (res, data) => res.json({ ok: true, ...data });
  const err = (res, msg, status = 500) => res.status(status).json({ ok: false, error: msg });
  const urlWebhook = () => (process.env.RENDER_EXTERNAL_URL || 'https://crearyjugargestion.onrender.com') + '/webhooks/tiendanube';
  const ayudaPermisos = (e) => (/: (401|403) /.test(e.message)
    ? ' — La app de Tiendanube no tiene permiso para pedidos. Agregalo en partners.tiendanube.com (permisos de la app: pedidos / read_orders), volvé a autorizar con /auth/tiendanube/install y actualizá TIENDANUBE_ACCESS_TOKEN en Render.'
    : '');

  // Productos de la app vinculados a los productos de Tiendanube que aparecen en el pedido
  async function productosVinculados(tnIds) {
    const ids = [...new Set(tnIds.filter(Boolean).map(Number))];
    if (!ids.length) return {};
    const filas = await sb('GET', 'proveedores', {
      filter: `tiendanube_product_id=in.(${ids.join(',')})`,
      select: 'id,nombre,proveedor,categoria,stock,tiendanube_product_id',
      limit: 1000,
    });
    const m = {};
    (filas || []).forEach(f => { m[String(f.tiendanube_product_id)] = f; });
    return m;
  }

  // Convierte un pedido de Tiendanube en una fila de la tabla ventas
  function armarVenta(order, vinc) {
    const productos = order.products || [];
    const lineas = productos.map(p => {
      const prod = vinc[String(p.product_id)] || null;
      const cantidad = num(p.quantity);
      return {
        prod, cantidad,
        item: {
          nombre: prod ? prod.nombre : String(p.name || 'Producto de Tiendanube'),
          cantidad,
          categoria: prod ? (prod.categoria || '') : '',
          proveedor: prod ? prod.proveedor : '',
          producto_id: prod ? prod.id : null,
          precio_unitario: num(p.price),
        },
      };
    });
    const subtotal = r2(lineas.reduce((a, l) => a + l.item.precio_unitario * l.cantidad, 0));
    // Lo que realmente pagó el cliente por los productos (con descuentos y cupones), sin el envío
    let total = order.total !== undefined && order.total !== null
      ? num(order.total) - num(order.shipping_cost_customer)
      : num(order.subtotal || subtotal) - num(order.discount);
    total = r2(Math.max(0, total));
    const descuentoPct = subtotal > 0 ? r2(Math.max(0, (1 - total / subtotal) * 100)) : 0;
    const fecha = new Date(order.paid_at || order.created_at || Date.now()).toISOString();
    return {
      lineas,
      venta: {
        id: `TN-${order.id}`,
        fecha,
        items: lineas.map(l => l.item),
        subtotal,
        descuento_pct: descuentoPct,
        total,
        medio_pago: 'Tienda Nube',
        impuesto_pct: 0,
        neto_estimado: total,
        historico: false,
      },
    };
  }

  // Suma (signo +1) o resta (signo -1) unidades al stock de la app y avisa a la tienda
  async function moverStock(lineas, signo) {
    const movimientos = [], sinCargar = [];
    for (const l of lineas) {
      if (!l.prod || !l.cantidad) continue;
      const filas = await sb('GET', 'proveedores', { filter: `id=eq.${l.prod.id}`, select: 'stock' });
      const actual = filas && filas[0] ? filas[0].stock : null;
      if (actual === null || actual === undefined) { sinCargar.push(l.prod.nombre); continue; }
      const nuevo = Math.max(0, Number(actual) + signo * l.cantidad);
      await sb('PATCH', `proveedores?id=eq.${l.prod.id}`, { body: { stock: nuevo, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
      movimientos.push({ producto: l.prod.nombre, de: Number(actual), a: nuevo });
      empujarStockTn(l.prod.id).catch(e => console.error(`[pedidos-tn] no se pudo enviar el stock de ${l.prod.nombre}: ${e.message}`));
    }
    return { movimientos, sinCargar };
  }

  async function procesarPagado(orderId, aplicar) {
    const order = await tn('GET', `/orders/${orderId}`);
    if (!order) return { omitido: 'pedido no encontrado' };
    if (order.payment_status && order.payment_status !== 'paid') return { omitido: `el pedido no está pagado (estado: ${order.payment_status})` };
    if (order.status === 'cancelled') return { omitido: 'el pedido está cancelado' };

    const vinc = await productosVinculados((order.products || []).map(p => p.product_id));
    const { lineas, venta } = armarVenta(order, vinc);
    const sinVincular = lineas.filter(l => !l.prod).map(l => l.item.nombre);
    const resumen = {
      venta_id: venta.id, numero_pedido: order.number, total: venta.total, subtotal: venta.subtotal, descuento_pct: venta.descuento_pct,
      items: venta.items.map(i => `${i.cantidad} × ${i.nombre}`),
      sin_vincular_en_la_app: sinVincular,
    };
    if (!aplicar) return { simulacion: true, ...resumen };

    // La venta se guarda primero: si Tiendanube avisa dos veces del mismo pedido, la segunda se ignora y no se descuenta de nuevo
    const insertada = await sb('POST', 'ventas', { body: venta, prefer: 'resolution=ignore-duplicates,return=representation' });
    if (!Array.isArray(insertada) || insertada.length === 0) return { omitido: 'este pedido ya estaba registrado', ...resumen };

    const { movimientos, sinCargar } = await moverStock(lineas, -1);
    console.log(`[pedidos-tn] pedido #${order.number}: venta ${venta.id} registrada por $${venta.total}; stock descontado en ${movimientos.length} producto(s)`);
    return { registrada: true, ...resumen, stock_descontado: movimientos, stock_sin_cargar_no_se_toco: sinCargar };
  }

  async function procesarCancelado(orderId, aplicar) {
    const ventaId = `TN-${orderId}`;
    const filas = await sb('GET', 'ventas', { filter: `id=eq.${ventaId}`, select: 'id,items,total' });
    const v = filas && filas[0];
    if (!v) return { omitido: 'no había una venta registrada para este pedido' };
    let items = v.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = []; } }
    const ids = (items || []).map(i => i.producto_id).filter(Boolean);
    const lineas = (items || []).filter(i => i.producto_id).map(i => ({ prod: { id: i.producto_id, nombre: i.nombre }, cantidad: num(i.cantidad) }));
    if (!aplicar) return { simulacion: true, venta_id: ventaId, devolveria_stock_de: ids.length };
    const { movimientos, sinCargar } = await moverStock(lineas, +1);
    await sb('DELETE', `ventas?id=eq.${ventaId}`);
    console.log(`[pedidos-tn] pedido ${orderId} cancelado: venta ${ventaId} eliminada; stock devuelto en ${movimientos.length} producto(s)`);
    return { cancelada: true, venta_id: ventaId, stock_devuelto: movimientos, stock_sin_cargar_no_se_toco: sinCargar };
  }

  // ── Receptor de avisos de Tiendanube ─────────────────────────────────────
  app.post('/webhooks/tiendanube', async (req, res) => {
    const secreto = process.env.TIENDANUBE_CLIENT_SECRET;
    const crudo = req.rawBody;
    if (!secreto || !crudo) return err(res, 'Servidor sin configurar para webhooks', 500);
    const firma = String(req.get('x-linkedstore-hmac-sha256') || '');
    const esperada = crypto.createHmac('sha256', secreto).update(crudo).digest('hex');
    const valida = firma.length === esperada.length && crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
    if (!valida) return err(res, 'Firma inválida', 401);

    const { event, id } = req.body || {};
    try {
      let r = { omitido: `evento ${event} ignorado` };
      if (event === 'order/paid') r = await procesarPagado(id, true);
      else if (event === 'order/cancelled') r = await procesarCancelado(id, true);
      ok(res, { resultado: r });
    } catch (e) {
      // Se responde con error para que Tiendanube vuelva a avisar más tarde (es seguro: un pedido ya registrado no se duplica)
      console.error(`[pedidos-tn] error con ${event} ${id}: ${e.message}`);
      err(res, e.message, 500);
    }
  });

  // ── Utilidades ───────────────────────────────────────────────────────────
  app.post('/api/tiendanube/webhooks/registrar', async (req, res) => {
    try {
      const url = urlWebhook();
      const existentes = (await tn('GET', '/webhooks')) || [];
      const creados = [], yaEstaban = [];
      for (const event of ['order/paid', 'order/cancelled']) {
        if (existentes.some(w => w.event === event && w.url === url)) { yaEstaban.push(event); continue; }
        const w = await tn('POST', '/webhooks', { event, url });
        creados.push({ event, id: w && w.id });
      }
      ok(res, { url, creados, ya_estaban: yaEstaban });
    } catch (e) { err(res, e.message + ayudaPermisos(e)); }
  });

  app.get('/api/tiendanube/webhooks', async (req, res) => {
    try { ok(res, { webhooks: (await tn('GET', '/webhooks')) || [] }); }
    catch (e) { err(res, e.message + ayudaPermisos(e)); }
  });

  app.get('/api/tiendanube/pedidos/ultimos', async (req, res) => {
    try {
      const pedidos = (await tn('GET', '/orders?per_page=10')) || [];
      ok(res, { pedidos: pedidos.map(o => ({
        id: o.id, numero: o.number, fecha: o.created_at, estado_pago: o.payment_status, estado: o.status, total: o.total,
        productos: (o.products || []).map(p => `${p.quantity} × ${p.name}`),
      })) });
    } catch (e) { err(res, e.message + ayudaPermisos(e)); }
  });

  // Simula (por defecto) o registra (con ?aplicar=1) un pedido puntual, p. ej. para recuperar uno que no llegó
  app.post('/api/tiendanube/pedidos/procesar/:id', async (req, res) => {
    try { ok(res, { resultado: await procesarPagado(req.params.id, req.query.aplicar === '1') }); }
    catch (e) { err(res, e.message + ayudaPermisos(e)); }
  });
};
