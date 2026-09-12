// auth-tiendanube.js
//
// Flujo de autorización OAuth de Tiendanube para obtener TIENDANUBE_ACCESS_TOKEN
// y TIENDANUBE_STORE_ID por única vez (no hace falta repetirlo salvo que se
// desinstale la app de la tienda).
//
// Cómo integrarlo en server.js (junto con tiendanube-reconciliacion.js):
//   const registrarAuthTiendanube = require('./auth-tiendanube');
//   registrarAuthTiendanube(app);
//
// Requiere en Render, ANTES de usar esto:
//   TIENDANUBE_CLIENT_ID       (de partners.tiendanube.com, app 39540)
//   TIENDANUBE_CLIENT_SECRET   (idem)
//
// Uso:
//   1. Entrá desde el navegador a: https://TU-BACKEND.onrender.com/auth/tiendanube/install
//   2. Te va a mandar a Tiendanube para loguearte como admin de la tienda y autorizar la app.
//   3. Tiendanube te redirige de vuelta a /auth/tiendanube/callback, que te muestra en
//      pantalla (en JSON) el access_token y el store_id (user_id).
//   4. Copiás esos dos valores a mano en Render como TIENDANUBE_ACCESS_TOKEN y
//      TIENDANUBE_STORE_ID.

module.exports = function registrarAuthTiendanube(app) {

  app.get('/auth/tiendanube/install', (req, res) => {
    const clientId = process.env.TIENDANUBE_CLIENT_ID;
    if (!clientId) {
      return res.status(500).send('Falta configurar TIENDANUBE_CLIENT_ID en Render.');
    }
    const url = `https://www.tiendanube.com/apps/${clientId}/authorize`;
    res.redirect(url);
  });

  app.get('/auth/tiendanube/callback', async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) return res.status(400).send('Falta el parámetro "code" en la redirección de Tiendanube.');

      const clientId = process.env.TIENDANUBE_CLIENT_ID;
      const clientSecret = process.env.TIENDANUBE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return res.status(500).send('Faltan TIENDANUBE_CLIENT_ID / TIENDANUBE_CLIENT_SECRET en Render.');
      }

      const resp = await fetch('https://www.tiendanube.com/apps/authorize/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        return res.status(resp.status).json({ ok: false, error: data });
      }

      // data trae: access_token, token_type, scope, user_id (= store id)
      res.send(`
        <h2>¡Autorización exitosa!</h2>
        <p>Copiá estos dos valores en Render, en Environment Variables:</p>
        <ul>
          <li><b>TIENDANUBE_ACCESS_TOKEN</b> = ${data.access_token}</li>
          <li><b>TIENDANUBE_STORE_ID</b> = ${data.user_id}</li>
        </ul>
        <p>Después guardá los cambios en Render y esperá el redeploy.</p>
      `);
    } catch (e) {
      res.status(500).send('Error: ' + e.message);
    }
  });
};
