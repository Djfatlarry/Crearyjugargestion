// instagram-render.js
//
// Render de plantillas de Instagram (1080x1350) con Satori (layout -> SVG) + resvg (SVG -> PNG).
// Sin navegador: entra cómodo en los 512 MB del plan starter de Render.
//
// Cada plantilla es una función que devuelve un árbol de nodos estilo React ({ type, props }),
// que Satori entiende sin necesidad de JSX.

const fs = require('fs');
const path = require('path');
const satori = require('satori').default;
const { Resvg } = require('@resvg/resvg-js');

const W = 1080;
const H = 1350;

const COLORES = {
  lavanda: '#8F83B9',
  durazno: '#F7D5C4',
  menta: '#BCE3DE',
  manteca: '#FFF0B3',
  violeta: '#52486C',
  blanco: '#FFFFFF',
};

// Fondos que alternan en las slides de producto del carrusel
const FONDOS_PRODUCTO = [COLORES.durazno, COLORES.menta, COLORES.manteca, COLORES.blanco];

const URL_TIENDA = 'crearyjugar.mitiendanube.com';
const LOGO_PATH = path.join(__dirname, 'assets', 'logo-crear-y-jugar.png');

// --- Tipografías (empaquetadas vía @fontsource, sin depender de red en runtime) ---

function fuente(pkg, archivo) {
  return fs.readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files', archivo));
}

let _fuentes = null;
function fuentes() {
  if (_fuentes) return _fuentes;
  const pf = '@fontsource/playfair-display';
  const lx = '@fontsource/lexend';
  _fuentes = [
    { name: 'Playfair Display', weight: 700, style: 'normal', data: fuente(pf, 'playfair-display-latin-700-normal.woff') },
    { name: 'Playfair Display', weight: 800, style: 'normal', data: fuente(pf, 'playfair-display-latin-800-normal.woff') },
    { name: 'Playfair Display', weight: 400, style: 'italic', data: fuente(pf, 'playfair-display-latin-400-italic.woff') },
    { name: 'Playfair Display', weight: 700, style: 'italic', data: fuente(pf, 'playfair-display-latin-700-italic.woff') },
    { name: 'Lexend', weight: 400, style: 'normal', data: fuente(lx, 'lexend-latin-400-normal.woff') },
    { name: 'Lexend', weight: 500, style: 'normal', data: fuente(lx, 'lexend-latin-500-normal.woff') },
    { name: 'Lexend', weight: 600, style: 'normal', data: fuente(lx, 'lexend-latin-600-normal.woff') },
  ];
  return _fuentes;
}

// --- Helpers ---

function h(type, style, ...children) {
  const kids = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
  // Satori exige display explícito en todo div con más de un hijo: flex por defecto
  return { type, props: { style: { display: 'flex', ...style }, children: kids.length === 1 ? kids[0] : kids } };
}

function img(src, style) {
  return { type: 'img', props: { src, style } };
}

function aDataUri(buffer, mime) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function mimeDeBuffer(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF') return 'image/webp';
  return 'image/png';
}

// Acepta URL http(s), data URI, ruta local o Buffer; devuelve data URI (o null)
async function cargarImagen(fuenteImg) {
  if (!fuenteImg) return null;
  if (Buffer.isBuffer(fuenteImg)) return aDataUri(fuenteImg, mimeDeBuffer(fuenteImg));
  if (fuenteImg.startsWith('data:')) return fuenteImg;
  if (/^https?:\/\//.test(fuenteImg)) {
    const r = await fetch(fuenteImg);
    if (!r.ok) throw new Error(`No se pudo bajar imagen ${fuenteImg}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return aDataUri(buf, mimeDeBuffer(buf));
  }
  if (fs.existsSync(fuenteImg)) {
    const buf = fs.readFileSync(fuenteImg);
    return aDataUri(buf, mimeDeBuffer(buf));
  }
  return null;
}

let _logo;
function logoDataUri() {
  if (_logo === undefined) _logo = fs.existsSync(LOGO_PATH) ? aDataUri(fs.readFileSync(LOGO_PATH), 'image/png') : null;
  return _logo;
}

// Si todavía no está el PNG del logo en assets/, dibujamos una aproximación para no bloquear el render
function logo(tam) {
  const uri = logoDataUri();
  if (uri) return img(uri, { width: tam, height: tam });
  return h('div', {
    width: tam, height: tam, borderRadius: tam, backgroundColor: COLORES.lavanda,
    border: `${Math.round(tam * 0.05)}px solid ${COLORES.menta}`,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    color: '#FBF3E4', fontFamily: 'Lexend', fontWeight: 600, lineHeight: 1,
  },
    h('div', { fontSize: tam * 0.17, whiteSpace: 'nowrap' }, 'CREAR'),
    h('div', { fontSize: tam * 0.17, whiteSpace: 'nowrap' }, 'Y JUGAR'),
  );
}

function pastilla(texto, { fondo, color, tam = 28, peso = 500, padX = 28, padY = 12, borde } = {}) {
  return h('div', {
    display: 'flex', backgroundColor: fondo, color, fontFamily: 'Lexend', fontWeight: peso,
    fontSize: tam, padding: `${padY}px ${padX}px`, borderRadius: 999, lineHeight: 1.1,
    border: borde || 'none',
  }, texto);
}

// --- Plantilla: slide de producto del carrusel ---
//
// datos: {
//   nombre, frase, edad, habilidades: [..], foto (URL/ruta/Buffer de la foto recortada),
//   indice (1-based), total, fondo? (si no, alterna según indice)
// }
async function slideProducto(datos) {
  const { nombre, frase, edad, habilidades = [], indice = 1, total = 1 } = datos;
  const fondo = datos.fondo || FONDOS_PRODUCTO[(indice - 1) % FONDOS_PRODUCTO.length];
  const esBlanco = fondo === COLORES.blanco;
  const foto = await cargarImagen(datos.foto);

  // Sobre fondo blanco, las pastillas blancas necesitan contraste: van en lavanda suave
  const fondoPastilla = esBlanco ? '#EFECF6' : COLORES.blanco;
  const halo = esBlanco ? COLORES.menta : 'rgba(255,255,255,0.55)';

  const zonaFoto = foto
    ? img(foto, { width: 760, height: 620, objectFit: 'contain' })
    : h('div', {
      width: 620, height: 560, borderRadius: 48, border: `6px dashed ${COLORES.violeta}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      color: COLORES.violeta, fontFamily: 'Lexend', fontSize: 30, opacity: 0.55, padding: 40,
    }, 'FOTO RECORTADA DEL PRODUCTO');

  return h('div', {
    width: W, height: H, backgroundColor: fondo, display: 'flex', flexDirection: 'column',
    padding: '64px 72px 56px', color: COLORES.violeta, fontFamily: 'Lexend', position: 'relative',
  },
    // Arriba: contador + edad
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
      pastilla(`${indice} / ${total}`, { fondo: 'transparent', color: COLORES.violeta, borde: `3px solid ${COLORES.violeta}`, tam: 26, peso: 600, padY: 10 }),
      edad ? pastilla(edad, { fondo: COLORES.lavanda, color: COLORES.blanco, tam: 28, peso: 600 }) : null,
    ),

    // Foto grande con halo circular detrás
    h('div', { display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', position: 'relative', marginTop: 8 },
      h('div', { position: 'absolute', width: 640, height: 640, borderRadius: 640, backgroundColor: halo }),
      zonaFoto,
    ),

    // Nombre
    h('div', {
      display: 'flex', justifyContent: 'center', textAlign: 'center', fontFamily: 'Playfair Display',
      fontWeight: 800, fontSize: nombre.length > 22 ? 64 : 80, lineHeight: 1.05, letterSpacing: 1,
      textTransform: 'uppercase', marginTop: 8,
    }, nombre),

    // Frase pedagógica
    frase ? h('div', {
      display: 'flex', justifyContent: 'center', textAlign: 'center', fontSize: 34, lineHeight: 1.4,
      marginTop: 20, padding: '0 20px',
    }, frase) : null,

    // Habilidades
    habilidades.length ? h('div', { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 16, marginTop: 28 },
      habilidades.map((hab) => pastilla(hab, { fondo: fondoPastilla, color: COLORES.violeta, tam: 28 })),
    ) : null,

    // Pie: URL + logo
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 32 },
      h('div', { display: 'flex', fontSize: 26, fontWeight: 500, opacity: 0.85, paddingBottom: 18 }, URL_TIENDA),
      logo(128),
    ),
  );
}

// --- Render ---

async function aPng(arbol) {
  const svg = await satori(arbol, { width: W, height: H, fonts: fuentes() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
}

const PLANTILLAS = {
  producto: slideProducto,
};

async function renderizar(plantilla, datos) {
  const fn = PLANTILLAS[plantilla];
  if (!fn) throw new Error(`Plantilla desconocida: ${plantilla}`);
  return aPng(await fn(datos));
}

module.exports = { renderizar, COLORES, W, H };
