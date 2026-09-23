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
const sharp = require('sharp');

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

// Base cálida para el carrusel de producto único (entre blanco y manteca)
const CREMA = '#FFF8EE';

const URL_TIENDA = 'crearyjugar.mitiendanube.com';
const LOGO_PATH = process.env.IG_LOGO_PATH || path.join(__dirname, 'assets', 'logo-crear-y-jugar.png');

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

// Satori solo lee PNG/JPEG: lo demás (webp de Tiendanube, por ejemplo) se pasa a PNG con sharp
async function normalizar(buf) {
  const mime = mimeDeBuffer(buf);
  if (mime === 'image/png' || mime === 'image/jpeg') return aDataUri(buf, mime);
  return aDataUri(await sharp(buf).png().toBuffer(), 'image/png');
}

// Acepta URL http(s), data URI, ruta local o Buffer; devuelve data URI (o null)
async function cargarImagen(fuenteImg) {
  if (!fuenteImg) return null;
  if (Buffer.isBuffer(fuenteImg)) return normalizar(fuenteImg);
  if (fuenteImg.startsWith('data:')) return fuenteImg;
  if (/^https?:\/\//.test(fuenteImg)) {
    const r = await fetch(fuenteImg);
    if (!r.ok) throw new Error(`No se pudo bajar imagen ${fuenteImg}: ${r.status}`);
    return normalizar(Buffer.from(await r.arrayBuffer()));
  }
  if (fs.existsSync(fuenteImg)) return normalizar(fs.readFileSync(fuenteImg));
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
  if (uri) return img(uri, { width: tam, height: tam, borderRadius: tam });
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

// --- Decoración: manchas orgánicas + chispitas ---
//
// Se dibuja como un SVG aparte que va de fondo a pantalla completa. Pocas piezas y en los bordes,
// para dar calidez sin competir con el producto.

// Curva cerrada suave (Catmull-Rom -> Bézier) alrededor de (cx, cy), con radios que varían por punto
function mancha(cx, cy, r, variacion, color) {
  const n = variacion.length;
  const pts = variacion.map((v, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v];
  });
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return `<path d="${d} Z" fill="${color}"/>`;
}

const ICONOS = {
  chispa: 'M12 0 C13 7 17 11 24 12 C17 13 13 17 12 24 C11 17 7 13 0 12 C7 11 11 7 12 0 Z',
  corazon: 'M12 21 C5 15 1 11.5 1 7.5 C1 4.4 3.4 2 6.5 2 C8.6 2 10.6 3.1 12 5 C13.4 3.1 15.4 2 17.5 2 C20.6 2 23 4.4 23 7.5 C23 11.5 19 15 12 21 Z',
  flecha: 'M2 10.5 H17.5 L12 5 L14.1 2.9 L23.2 12 L14.1 21.1 L12 19 L17.5 13.5 H2 Z',
  estrella: 'M12 1.5 L15 8.5 L22.5 9.2 L16.8 14.2 L18.5 21.8 L12 17.8 L5.5 21.8 L7.2 14.2 L1.5 9.2 L9 8.5 Z',
};

function iconoSvg(tipo, x, y, tam, color, rot = 0) {
  const k = tam / 24;
  return `<path d="${ICONOS[tipo]}" fill="${color}" transform="translate(${x} ${y}) rotate(${rot} ${tam / 2} ${tam / 2}) scale(${k})"/>`;
}

// Nodo SVG de Satori con un ícono (para usar dentro de pastillas/tarjetas)
function icono(tipo, tam, color) {
  return {
    type: 'svg',
    props: {
      width: tam, height: tam, viewBox: '0 0 24 24',
      children: { type: 'path', props: { d: ICONOS[tipo], fill: color } },
    },
  };
}

// --- Temas de color ---
//
// Cada tema define, por slide, el fondo, las manchas de las esquinas, los colores de las chispitas y
// de los textos, y opcionalmente un panel de color liso detrás del contenido.
//   crema: base cálida con manchas pastel suaves
//   color: cada slide con un fondo pleno de la paleta (lavanda / menta / durazno)
//   panel: base crema con un bloque de color grande que ordena la slide

const TEMAS = {
  crema: {
    portada: {
      fondo: CREMA, texto: COLORES.violeta, acento: COLORES.lavanda, edad: [COLORES.lavanda, COLORES.blanco],
      manchas: ['#E4DEF3', '#D6EEEA', '#FBE3D7'], iconos: [COLORES.lavanda, '#F2B8A0', '#F5D76E', '#8CCFC6'],
    },
    detalle: {
      fondo: CREMA, texto: COLORES.violeta, acento: COLORES.lavanda, edad: [COLORES.lavanda, COLORES.blanco],
      manchas: ['#FBE3D7', '#E4DEF3'], iconos: ['#F5D76E', COLORES.lavanda, '#F2B8A0'],
    },
    desarrolla: {
      fondo: CREMA, texto: COLORES.violeta, acento: COLORES.lavanda,
      manchas: ['#D6EEEA', '#FFF0B3'], iconos: [COLORES.lavanda, '#F2B8A0', '#8CCFC6'],
    },
  },
  color: {
    portada: {
      fondo: COLORES.lavanda, texto: COLORES.blanco, acento: COLORES.manteca, edad: [COLORES.manteca, COLORES.violeta],
      manchas: ['#9D92C5', '#8174AE', '#9D92C5'], iconos: [COLORES.manteca, COLORES.blanco, COLORES.menta, COLORES.durazno],
      logoAro: true,
    },
    detalle: {
      fondo: COLORES.menta, texto: COLORES.violeta, acento: COLORES.violeta, edad: [COLORES.violeta, COLORES.blanco],
      manchas: ['#CFECE8', '#A6D6CF'], iconos: [COLORES.blanco, COLORES.lavanda, COLORES.manteca],
    },
    desarrolla: {
      fondo: COLORES.durazno, texto: COLORES.violeta, acento: '#7A6BA8',
      manchas: ['#FBE4D9', '#EFC1AB'], iconos: [COLORES.blanco, COLORES.lavanda, COLORES.manteca],
    },
  },
  panel: {
    portada: {
      fondo: CREMA, texto: COLORES.violeta, acento: COLORES.lavanda, edad: [COLORES.lavanda, COLORES.blanco],
      manchas: [null, null, '#FBE3D7'], iconos: [COLORES.lavanda, '#F2B8A0', COLORES.blanco, COLORES.blanco],
      panel: { color: COLORES.menta, top: 640, left: 0, right: 0, bottom: 0, radius: '120px 120px 0 0' },
    },
    detalle: {
      fondo: CREMA, texto: COLORES.violeta, acento: COLORES.lavanda, edad: [COLORES.lavanda, COLORES.blanco],
      manchas: [null, null], iconos: ['#F5D76E', COLORES.lavanda, '#F2B8A0'],
      panel: { color: COLORES.manteca, top: 330, left: 0, right: 0, bottom: 440, radius: 0 },
    },
    desarrolla: {
      fondo: CREMA, texto: COLORES.violeta, acento: COLORES.lavanda, cabecera: true,
      manchas: [null, null], iconos: [COLORES.manteca, '#F2B8A0', '#8CCFC6'],
      panel: { color: COLORES.lavanda, top: 0, left: 0, right: 0, bottom: 880, radius: '0 0 80px 80px' },
    },
  },
};

function temaDe(d, slide) {
  return (TEMAS[d.tema] || TEMAS.crema)[slide];
}

// Posiciones de manchas y chispitas por slide (los colores los pone el tema; null = sin mancha)
const DECORACIONES = {
  portada: (m, c) => [
    m[0] && mancha(40, 120, 230, [1, 0.8, 1.1, 0.9, 1.2, 0.85, 1, 0.9], m[0]),
    m[1] && mancha(1060, 1260, 260, [1, 1.15, 0.85, 1, 0.9, 1.1, 0.95, 1], m[1]),
    m[2] && mancha(1080, 120, 120, [1, 0.9, 1.2, 1, 0.8, 1.1], m[2]),
    iconoSvg('chispa', 150, 380, 30, c[0], 0),
    iconoSvg('corazon', 960, 500, 30, c[1], -12),
    iconoSvg('estrella', 70, 980, 34, c[2], 10),
    iconoSvg('chispa', 990, 860, 24, c[3], 0),
  ],
  detalle: (m, c) => [
    m[0] && mancha(1040, 80, 240, [1, 0.85, 1.1, 0.95, 1.2, 0.9, 1, 0.8], m[0]),
    m[1] && mancha(0, 1300, 280, [1.1, 0.9, 1, 1.15, 0.85, 1, 0.9, 1.05], m[1]),
    iconoSvg('estrella', 90, 180, 30, c[0], -8),
    iconoSvg('chispa', 960, 520, 28, c[1], 0),
    iconoSvg('corazon', 110, 760, 26, c[2], 10),
  ],
  desarrolla: (m, c) => [
    m[0] && mancha(0, 60, 250, [1, 1.1, 0.9, 1, 1.2, 0.85, 1.05, 0.9], m[0]),
    m[1] && mancha(1080, 1180, 300, [1, 0.9, 1.1, 0.85, 1, 1.15, 0.9, 1], m[1]),
    iconoSvg('chispa', 960, 170, 30, c[0], 0),
    iconoSvg('corazon', 80, 1180, 28, c[1], -10),
    iconoSvg('estrella', 990, 420, 26, c[2], 12),
  ],
};

// Capas de fondo: panel liso (si el tema lo pide) + manchas y chispitas
function fondoDecorado(slide, t) {
  const capas = [];
  if (t.panel) {
    const { color, radius, ...pos } = t.panel;
    capas.push(h('div', { position: 'absolute', backgroundColor: color, borderRadius: radius, ...pos }));
  }
  const piezas = DECORACIONES[slide](t.manchas, t.iconos).filter(Boolean).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${piezas}</svg>`;
  capas.push(img(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, { position: 'absolute', top: 0, left: 0, width: W, height: H }));
  return capas;
}

// Foto del producto: si está recortada flota con sombra; si es foto con fondo, va en marco tipo polaroid
function fotoProducto(src, { ancho, alto, recortada, rot = -2 }) {
  if (recortada && src) return img(src, { width: ancho, height: alto, objectFit: 'contain' });
  return h('div', {
    padding: 14, backgroundColor: COLORES.blanco, borderRadius: 36, transform: `rotate(${rot}deg)`,
    boxShadow: '0 18px 40px rgba(82,72,108,0.18)',
  },
    src
      ? img(src, { width: ancho - 28, height: alto - 28, objectFit: 'cover', borderRadius: 26 })
      // Sin foto (preview): mismo marco con un hueco neutro, para evaluar la composición igual
      : h('div', {
        width: ancho - 28, height: alto - 28, borderRadius: 26, backgroundColor: '#ECE8E3',
        alignItems: 'center', justifyContent: 'center', color: '#A39DB0', fontSize: 28, letterSpacing: 3,
      }, 'FOTO DEL PRODUCTO'),
  );
}

function contador(indice, total, color = COLORES.violeta) {
  return pastilla(`${indice} / ${total}`, { fondo: 'transparent', color, borde: `3px solid ${color}`, tam: 24, peso: 600, padY: 8, padX: 22 });
}

// --- Carrusel de producto único ---
//
// Un producto contado en varias slides, con poca información por slide:
//   portada -> foto de detalle -> "¿qué desarrolla?" -> (cierre compartido)
//
// datos comunes: { nombre, gancho, bajada, edad, fotos: [..], recortada, habilidades: [{ nombre, detalle }], indice, total }

async function unicoPortada(d) {
  const t = temaDe(d, 'portada');
  const foto = await cargarImagen(d.fotos?.[0]);
  return h('div', {
    width: W, height: H, backgroundColor: t.fondo, flexDirection: 'column', alignItems: 'center',
    padding: '56px 72px 52px', color: t.texto, fontFamily: 'Lexend', position: 'relative',
  },
    fondoDecorado('portada', t),
    t.logoAro ? h('div', { padding: 6, borderRadius: 200, backgroundColor: COLORES.blanco }, logo(144)) : logo(150),
    h('div', {
      marginTop: 18, fontFamily: 'Playfair Display', fontWeight: 800, fontSize: d.nombre.length > 14 ? 96 : 120,
      lineHeight: 1, letterSpacing: 2, textTransform: 'uppercase', textAlign: 'center', justifyContent: 'center',
    }, d.nombre),
    d.gancho ? h('div', {
      marginTop: 18, fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 400, fontSize: 46,
      color: t.acento, textAlign: 'center', justifyContent: 'center',
    }, d.gancho) : null,
    d.edad ? h('div', { marginTop: 22 }, pastilla(d.edad, { fondo: t.edad[0], color: t.edad[1], tam: 26, peso: 600, padY: 10 })) : null,
    h('div', { flexGrow: 1, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
      fotoProducto(foto, { ancho: 820, alto: 640, recortada: d.recortada }),
    ),
    h('div', { width: '100%', justifyContent: 'flex-end', alignItems: 'center', fontSize: 26, fontWeight: 500, marginTop: 12 },
      h('div', { marginRight: 10 }, 'Deslizá'),
      icono('flecha', 30, t.texto),
    ),
  );
}

async function unicoDetalle(d) {
  const t = temaDe(d, 'detalle');
  const foto = await cargarImagen(d.fotos?.[1] || d.fotos?.[0]);
  return h('div', {
    width: W, height: H, backgroundColor: t.fondo, flexDirection: 'column', alignItems: 'center',
    padding: '56px 72px 52px', color: t.texto, fontFamily: 'Lexend', position: 'relative',
  },
    fondoDecorado('detalle', t),
    h('div', { width: '100%', justifyContent: 'space-between', alignItems: 'center' },
      contador(d.indice, d.total, t.texto),
      d.edad ? pastilla(d.edad, { fondo: t.edad[0], color: t.edad[1], tam: 24, peso: 600, padY: 8 }) : null,
    ),
    h('div', { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
      fotoProducto(foto, { ancho: 760, alto: 860, recortada: d.recortada, rot: 2 }),
    ),
    d.bajada ? h('div', {
      backgroundColor: COLORES.blanco, borderRadius: 32, padding: '28px 40px', marginTop: 8,
      fontSize: 34, lineHeight: 1.35, textAlign: 'center', justifyContent: 'center', maxWidth: 880,
      boxShadow: '0 10px 30px rgba(82,72,108,0.10)',
    }, d.bajada) : null,
  );
}

const ESTILO_HABILIDAD = [
  { icono: 'corazon', fondo: '#FBE3D7', color: '#E48F6E' },
  { icono: 'estrella', fondo: '#FFF0B3', color: '#E0B530' },
  { icono: 'chispa', fondo: '#D6EEEA', color: '#5FB3A8' },
];

async function unicoDesarrolla(d) {
  const foto = await cargarImagen(d.fotos?.[0]);
  const t = temaDe(d, 'desarrolla');
  const habs = (d.habilidades || []).slice(0, 3);
  // Con cabecera de color, los títulos van en blanco/manteca sobre el panel
  const tituloColor = t.cabecera ? COLORES.blanco : t.texto;
  const acento = t.cabecera ? COLORES.manteca : t.acento;
  return h('div', {
    width: W, height: H, backgroundColor: t.fondo, flexDirection: 'column',
    padding: '56px 72px 52px', color: t.texto, fontFamily: 'Lexend', position: 'relative',
  },
    fondoDecorado('desarrolla', t),
    h('div', { justifyContent: 'space-between', alignItems: 'center' },
      contador(d.indice, d.total, tituloColor),
      foto ? h('div', { width: 150, height: 150, borderRadius: 150, overflow: 'hidden', border: `8px solid ${COLORES.blanco}`, boxShadow: '0 8px 24px rgba(82,72,108,0.15)' },
        img(foto, { width: 134, height: 134, objectFit: 'cover' })) : null,
    ),
    h('div', { flexDirection: 'column', marginTop: 40 },
      h('div', { fontSize: 26, fontWeight: 600, letterSpacing: 4, color: acento }, 'JUGANDO CON'),
      h('div', { fontFamily: 'Playfair Display', fontWeight: 800, fontSize: d.nombre.length > 18 ? 60 : 72, lineHeight: 1.05, textTransform: 'uppercase', marginTop: 6, color: tituloColor }, d.nombre),
      h('div', { fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 400, fontSize: 60, color: acento, marginTop: 4 }, '¿qué desarrolla?'),
    ),
    h('div', { flexDirection: 'column', marginTop: 48, flexGrow: 1 },
      habs.map((hab, i) => {
        const e = ESTILO_HABILIDAD[i % ESTILO_HABILIDAD.length];
        return h('div', {
          backgroundColor: COLORES.blanco, borderRadius: 32, padding: '30px 36px', marginBottom: 24,
          alignItems: 'center', boxShadow: '0 8px 24px rgba(82,72,108,0.08)',
        },
          h('div', { width: 84, height: 84, borderRadius: 84, backgroundColor: e.fondo, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
            icono(e.icono, 40, e.color)),
          h('div', { flexDirection: 'column', marginLeft: 28, flexShrink: 1 },
            h('div', { fontSize: 36, fontWeight: 600 }, hab.nombre),
            hab.detalle ? h('div', { fontSize: 27, lineHeight: 1.35, marginTop: 6, opacity: 0.85 }, hab.detalle) : null,
          ),
        );
      }),
    ),
    h('div', { justifyContent: 'space-between', alignItems: 'flex-end' },
      h('div', { fontSize: 26, fontWeight: 500, opacity: 0.85, paddingBottom: 20 }, URL_TIENDA),
      logo(120),
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
  unico_portada: unicoPortada,
  unico_detalle: unicoDetalle,
  unico_desarrolla: unicoDesarrolla,
};

async function renderizar(plantilla, datos) {
  const fn = PLANTILLAS[plantilla];
  if (!fn) throw new Error(`Plantilla desconocida: ${plantilla}`);
  return aPng(await fn(datos));
}

module.exports = { renderizar, COLORES, W, H };
