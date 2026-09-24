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
const { html: parsearHtml } = require('satori-html');

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
const DIRECCION_LOCAL = 'Ricardo Gutiérrez 1215, Olivos';
const USUARIO_IG = '@crearyjugardidacticos';
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
  if (fuenteImg === 'asset:logo') return logoDataUri();
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

// Referencia a una imagen para el HTML de la slide (URL, ruta local o 'asset:logo'); el archivo
// se carga recién al renderizar, así el HTML guardado queda liviano y editable.
function refImagen(fuente) {
  if (!fuente) return null;
  if (Buffer.isBuffer(fuente)) return aDataUri(fuente, mimeDeBuffer(fuente));
  return fuente;
}

// Si todavía no está el PNG del logo en assets/, dibujamos una aproximación para no bloquear el render
function logo(tam) {
  if (logoDataUri()) return img('asset:logo', { width: tam, height: tam, borderRadius: tam });
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
  const foto = refImagen(datos.foto);

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
  return { type: 'path', props: { d: `${d} Z`, fill: color } };
}

const ICONOS = {
  chispa: 'M12 0 C13 7 17 11 24 12 C17 13 13 17 12 24 C11 17 7 13 0 12 C7 11 11 7 12 0 Z',
  corazon: 'M12 21 C5 15 1 11.5 1 7.5 C1 4.4 3.4 2 6.5 2 C8.6 2 10.6 3.1 12 5 C13.4 3.1 15.4 2 17.5 2 C20.6 2 23 4.4 23 7.5 C23 11.5 19 15 12 21 Z',
  tienda: 'M2 8.5 L4.2 3 H19.8 L22 8.5 C22 10.2 20.7 11.5 19 11.5 C17.3 11.5 16 10.2 16 8.5 C16 10.2 14.7 11.5 13 11.5 H11 C9.3 11.5 8 10.2 8 8.5 C8 10.2 6.7 11.5 5 11.5 C3.3 11.5 2 10.2 2 8.5 Z M4 13 H20 V21 H14 V16 H10 V21 H4 Z',
  pin: 'M12 1.5 C7.6 1.5 4.2 4.9 4.2 9.2 C4.2 14.8 12 22.5 12 22.5 C12 22.5 19.8 14.8 19.8 9.2 C19.8 4.9 16.4 1.5 12 1.5 Z M12 12.2 C10.3 12.2 9 10.9 9 9.2 C9 7.5 10.3 6.2 12 6.2 C13.7 6.2 15 7.5 15 9.2 C15 10.9 13.7 12.2 12 12.2 Z',
  flecha: 'M2 10.5 H17.5 L12 5 L14.1 2.9 L23.2 12 L14.1 21.1 L12 19 L17.5 13.5 H2 Z',
  estrella: 'M12 1.5 L15 8.5 L22.5 9.2 L16.8 14.2 L18.5 21.8 L12 17.8 L5.5 21.8 L7.2 14.2 L1.5 9.2 L9 8.5 Z',
};

function iconoSvg(tipo, x, y, tam, color, rot = 0) {
  const k = tam / 24;
  return { type: 'path', props: { d: ICONOS[tipo], fill: color, transform: `translate(${x} ${y}) rotate(${rot} ${tam / 2} ${tam / 2}) scale(${k})` } };
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
    cierre: {
      fondo: CREMA, texto: COLORES.violeta, acento: COLORES.lavanda,
      manchas: [null, null], iconos: [COLORES.blanco, '#F2B8A0', '#F5D76E'],
      panel: { color: COLORES.menta, top: 0, left: 0, right: 0, bottom: 640, radius: '0 0 120px 120px' },
    },
  },
};

const TEMA_DEFAULT = 'panel';

function temaDe(d, slide) {
  // Si un tema no define una slide (ej. el cierre, que es compartido), usa la del tema por defecto
  return (TEMAS[d.tema] || TEMAS[TEMA_DEFAULT])[slide] || TEMAS[TEMA_DEFAULT][slide];
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
  cierre: (m, c) => [
    iconoSvg('chispa', 140, 150, 32, c[0], 0),
    iconoSvg('corazon', 940, 170, 30, c[1], 12),
    iconoSvg('estrella', 90, 1200, 30, c[2], -8),
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
  const piezas = DECORACIONES[slide](t.manchas, t.iconos).filter(Boolean);
  capas.push({ type: 'svg', props: { width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: { position: 'absolute', top: 0, left: 0 }, children: piezas } });
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
// datos comunes: { nombre, gancho, bajada, edad, fotos: [..], fotoRecortada?, habilidades: [{ nombre, detalle }], tema, indice, total }
// fotoRecortada (PNG sin fondo) se usa solo en la portada; el resto de las slides usa las fotos originales.
// fotoPortada / fotoDetalle / fotoMiniatura: índice de d.fotos para cada lugar (default 0 / 1 / 0).
// La foto recortada corresponde a fotos[0], así que solo se usa si la portada usa esa foto.

function fotoDe(d, clave, porDefecto) {
  const fotos = d.fotos || [];
  const i = Number.isInteger(d[clave]) ? d[clave] : porDefecto;
  return fotos[i] || fotos[0];
}

async function unicoPortada(d) {
  const t = temaDe(d, 'portada');
  const usaRecorte = Boolean(d.fotoRecortada) && !d.fotoPortada;
  const foto = refImagen(usaRecorte ? d.fotoRecortada : fotoDe(d, 'fotoPortada', 0));
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
      fotoProducto(foto, { ancho: 820, alto: 640, recortada: usaRecorte }),
    ),
    h('div', { width: '100%', justifyContent: 'flex-end', alignItems: 'center', fontSize: 26, fontWeight: 500, marginTop: 12 },
      h('div', { marginRight: 10 }, 'Deslizá'),
      icono('flecha', 30, t.texto),
    ),
  );
}

async function unicoDetalle(d) {
  const t = temaDe(d, 'detalle');
  const foto = refImagen(fotoDe(d, 'fotoDetalle', 1));
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
      fotoProducto(foto, { ancho: 760, alto: 860, recortada: false, rot: 2 }),
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
  const foto = refImagen(fotoDe(d, 'fotoMiniatura', 0));
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

function tarjetaCierre(tipo, colorIcono, fondoIcono, titulo, texto) {
  return h('div', {
    backgroundColor: COLORES.blanco, borderRadius: 32, padding: '30px 36px', marginBottom: 24,
    alignItems: 'center', boxShadow: '0 8px 24px rgba(82,72,108,0.08)',
  },
    h('div', { width: 84, height: 84, borderRadius: 84, backgroundColor: fondoIcono, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      icono(tipo, 42, colorIcono)),
    h('div', { flexDirection: 'column', marginLeft: 28 },
      h('div', { fontSize: 24, fontWeight: 600, letterSpacing: 3, color: COLORES.lavanda }, titulo),
      h('div', { fontSize: 34, fontWeight: 500, marginTop: 6 }, texto),
    ),
  );
}

// Cierre compartido por los carruseles: dónde encontrarnos
async function cierre(d = {}) {
  const t = temaDe(d, 'cierre');
  return h('div', {
    width: W, height: H, backgroundColor: t.fondo, flexDirection: 'column', alignItems: 'center',
    padding: '56px 72px 60px', color: t.texto, fontFamily: 'Lexend', position: 'relative',
  },
    fondoDecorado('cierre', t),
    d.indice ? h('div', { width: '100%' }, contador(d.indice, d.total, t.texto)) : null,
    h('div', { marginTop: 30, padding: 10, borderRadius: 400, backgroundColor: COLORES.blanco, boxShadow: '0 12px 32px rgba(82,72,108,0.12)' }, logo(280)),
    h('div', { marginTop: 36, fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 400, fontSize: 52 }, 'Encontralos en'),
    h('div', { fontFamily: 'Playfair Display', fontWeight: 800, fontSize: 88, letterSpacing: 2, lineHeight: 1.05 }, 'CREAR Y JUGAR'),
    h('div', { flexDirection: 'column', width: '100%', marginTop: 44 },
      tarjetaCierre('tienda', '#5FB3A8', '#D6EEEA', 'TIENDA ONLINE', 'Link en la bio'),
      tarjetaCierre('pin', '#E48F6E', '#FBE3D7', 'NUESTRO LOCAL', DIRECCION_LOCAL),
    ),
    h('div', { flexGrow: 1 }),
    h('div', { fontSize: 32, fontWeight: 600, color: t.acento }, USUARIO_IG),
  );
}

// --- Plantillas: carrusel de varios productos, producto en una imagen, institucional y fecha especial ---

// Capa de decoración a pantalla completa con las piezas (manchas, chispitas, corazones) que se le pasen
function capaSvg(piezas) {
  return { type: 'svg', props: { width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: { position: 'absolute', top: 0, left: 0 }, children: piezas.filter(Boolean) } };
}

function logoConAro(tam, aro = COLORES.blanco) {
  return h('div', { padding: Math.round(tam * 0.05), borderRadius: tam, backgroundColor: aro }, logo(tam));
}

function lineaIcono(tipo, texto, color, tam = 30) {
  return h('div', { alignItems: 'center', gap: 12, fontSize: tam, fontWeight: 500, color },
    icono(tipo, Math.round(tam * 1.1), color), h('div', {}, texto));
}

// Portada del carrusel de varios productos: tema del carrusel y las fotos en círculos de colores
// d: { titulo, subtitulo, etiqueta?, fotos: [hasta 3 URLs] }
async function multiPortada(d) {
  const fotos = (d.fotos || []).slice(0, 3).map(refImagen);
  const circulos = [
    { tam: 470, left: 0, top: 70, aro: COLORES.menta },
    { tam: 360, left: 560, top: 10, aro: COLORES.durazno },
    { tam: 330, left: 450, top: 360, aro: COLORES.manteca },
  ];
  return h('div', {
    width: W, height: H, backgroundColor: COLORES.lavanda, flexDirection: 'column',
    padding: '72px 72px 56px', color: COLORES.blanco, fontFamily: 'Lexend', position: 'relative',
  },
    capaSvg([
      mancha(1060, 90, 250, [1, 0.85, 1.1, 0.95, 1.2, 0.9, 1, 0.8], '#9D92C5'),
      mancha(20, 1290, 270, [1.1, 0.9, 1, 1.15, 0.85, 1, 0.9, 1.05], '#8174AE'),
      iconoSvg('chispa', 930, 330, 34, COLORES.manteca, 0),
      iconoSvg('estrella', 80, 610, 30, COLORES.menta, 12),
      iconoSvg('corazon', 980, 1040, 30, COLORES.durazno, -10),
      iconoSvg('chispa', 1000, 640, 24, COLORES.blanco, 0),
    ]),
    h('div', {},
      pastilla(d.etiqueta || 'JUEGOS QUE ENSEÑAN', { fondo: 'rgba(255,255,255,0.18)', color: COLORES.blanco, tam: 24, peso: 600, padY: 10, padX: 24 })),
    h('div', { marginTop: 28, fontFamily: 'Playfair Display', fontWeight: 800, fontSize: d.titulo.length > 28 ? 84 : 100, lineHeight: 1.02, maxWidth: 900 }, d.titulo),
    d.subtitulo ? h('div', { marginTop: 22, fontSize: 34, lineHeight: 1.4, maxWidth: 820, opacity: 0.92 }, d.subtitulo) : null,
    // Fotos en círculos superpuestos
    h('div', { flexGrow: 1, position: 'relative', marginTop: 20 },
      ...fotos.map((f, i) => {
        const c = circulos[i];
        return h('div', {
          position: 'absolute', left: c.left, top: c.top, width: c.tam, height: c.tam, borderRadius: c.tam,
          backgroundColor: c.aro, padding: 14, boxShadow: '0 16px 40px rgba(42,37,54,0.25)',
        }, img(f, { width: c.tam - 28, height: c.tam - 28, borderRadius: c.tam, objectFit: 'cover' }));
      }),
    ),
    h('div', { justifyContent: 'space-between', alignItems: 'flex-end' },
      h('div', { alignItems: 'center', gap: 12, fontSize: 30, fontWeight: 600, paddingBottom: 30 }, h('div', {}, 'Deslizá'), icono('flecha', 34, COLORES.blanco)),
      logoConAro(130),
    ),
  );
}

// Un producto en una sola imagen: nombre, bajada, edad, foto y bloque "¿Qué desarrolla?"
// d: { nombre, bajada (o gancho), edad, fotos: [..], habilidades: [{ nombre }] }
async function productoImagen(d) {
  const foto = refImagen(fotoDe(d, 'fotoPortada', 0));
  const habs = (d.habilidades || []).slice(0, 3);
  return h('div', {
    width: W, height: H, backgroundColor: COLORES.manteca, flexDirection: 'column', alignItems: 'center',
    padding: '64px 64px 56px', color: COLORES.violeta, fontFamily: 'Lexend', position: 'relative',
  },
    capaSvg([
      mancha(1070, 560, 230, [1, 0.85, 1.1, 0.95, 1.2, 0.9, 1, 0.8], '#FFF7D6'),
      mancha(0, 420, 200, [1.1, 0.9, 1, 1.15, 0.85, 1, 0.9, 1.05], '#FFF7D6'),
      iconoSvg('chispa', 110, 110, 30, COLORES.lavanda, 0),
      iconoSvg('corazon', 940, 150, 28, '#F2B8A0', 12),
      iconoSvg('estrella', 960, 800, 26, '#8CCFC6', -8),
    ]),
    h('div', {
      fontFamily: 'Playfair Display', fontWeight: 800, fontSize: d.nombre.length > 16 ? 72 : 88, lineHeight: 1.02,
      textTransform: 'uppercase', textAlign: 'center', justifyContent: 'center', letterSpacing: 1,
    }, d.nombre),
    (d.bajada || d.gancho) ? h('div', {
      marginTop: 14, fontFamily: 'Playfair Display', fontStyle: 'italic', fontSize: 40, color: '#7A6BA8',
      textAlign: 'center', justifyContent: 'center', maxWidth: 880,
    }, d.gancho || d.bajada) : null,
    d.edad ? h('div', { marginTop: 18 }, pastilla(d.edad, { fondo: COLORES.lavanda, color: COLORES.blanco, tam: 26, peso: 600, padY: 10 })) : null,
    h('div', { flexGrow: 1, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
      fotoProducto(foto, { ancho: 700, alto: 500, recortada: false, rot: -2 })),
    h('div', { width: '100%', alignItems: 'flex-end', gap: 20 },
      h('div', {
        flexGrow: 1, flexDirection: 'column', backgroundColor: COLORES.blanco, borderRadius: 32, padding: '26px 32px',
        boxShadow: '0 10px 30px rgba(82,72,108,0.10)',
      },
        h('div', { fontSize: 24, fontWeight: 600, letterSpacing: 4, color: COLORES.lavanda }, '¿QUÉ DESARROLLA?'),
        h('div', { flexDirection: 'column', gap: 12, marginTop: 14 },
          habs.map((hab, i) => {
            const e = ESTILO_HABILIDAD[i % ESTILO_HABILIDAD.length];
            return h('div', { alignItems: 'center', gap: 16 },
              h('div', { width: 52, height: 52, borderRadius: 52, backgroundColor: e.fondo, alignItems: 'center', justifyContent: 'center' }, icono(e.icono, 26, e.color)),
              h('div', { fontSize: 32, fontWeight: 600 }, hab.nombre));
          })),
      ),
      logoConAro(120),
    ),
  );
}

// Institucional: frase de la marca, texto y datos del local
// d: { frase, texto }
async function institucional(d) {
  return h('div', {
    width: W, height: H, backgroundColor: COLORES.violeta, flexDirection: 'column',
    padding: '96px 84px 64px', color: COLORES.blanco, fontFamily: 'Lexend', position: 'relative',
  },
    capaSvg([
      mancha(1080, 60, 280, [1, 0.85, 1.1, 0.95, 1.2, 0.9, 1, 0.8], '#5E5379'),
      mancha(0, 1330, 300, [1.1, 0.9, 1, 1.15, 0.85, 1, 0.9, 1.05], '#5E5379'),
      iconoSvg('chispa', 940, 380, 32, COLORES.manteca, 0),
      iconoSvg('estrella', 180, 1020, 26, COLORES.menta, 10),
      iconoSvg('corazon', 900, 1000, 26, COLORES.durazno, -8),
    ]),
    h('div', { flexGrow: 1 }),
    h('div', { fontFamily: 'Playfair Display', fontWeight: 700, fontSize: 220, lineHeight: 0.8, color: COLORES.manteca, opacity: 0.5, height: 130 }, '“'),
    h('div', {
      fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 400, fontSize: d.frase.length > 60 ? 76 : 92,
      lineHeight: 1.15, color: COLORES.manteca, maxWidth: 900, marginTop: 10,
    }, d.frase),
    d.texto ? h('div', { marginTop: 48, fontSize: 34, lineHeight: 1.5, maxWidth: 860, opacity: 0.95 }, d.texto) : null,
    h('div', { flexGrow: 1 }),
    h('div', { justifyContent: 'space-between', alignItems: 'flex-end' },
      h('div', { flexDirection: 'column', gap: 14, paddingBottom: 10 },
        lineaIcono('pin', DIRECCION_LOCAL, COLORES.menta, 30),
        h('div', { fontSize: 30, fontWeight: 600, color: COLORES.menta }, USUARIO_IG)),
      logoConAro(140),
    ),
  );
}

// Fecha especial (Día de la Madre, de las Infancias, Navidad...): arriba durazno con corazones, fecha y
// saludo; abajo blanco con mensaje, horario y dirección
// d: { fecha, saludo, mensaje, horario? }
async function festivo(d) {
  const corazones = [
    [90, 120, 46, COLORES.blanco, -12], [930, 90, 40, '#F2B8A0', 10], [180, 470, 34, '#E48F6E', 8],
    [880, 430, 52, COLORES.blanco, -6], [520, 70, 28, '#E48F6E', 0], [60, 300, 26, '#F2B8A0', 14],
    [990, 300, 30, COLORES.blanco, -14],
  ].map(([x, y, t, c, r]) => iconoSvg('corazon', x, y, t, c, r));
  const onda = { type: 'path', props: { d: 'M0 640 C180 700 360 700 540 660 C720 620 900 610 1080 660 L1080 1350 L0 1350 Z', fill: COLORES.blanco } };
  return h('div', {
    width: W, height: H, backgroundColor: COLORES.durazno, flexDirection: 'column', alignItems: 'center',
    padding: '0 80px 56px', color: COLORES.violeta, fontFamily: 'Lexend', position: 'relative',
  },
    capaSvg([...corazones, onda]),
    // Mitad de arriba
    h('div', { height: 640, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
      pastilla(d.fecha, { fondo: COLORES.blanco, color: COLORES.violeta, tam: 28, peso: 600, padY: 12, padX: 30 }),
      h('div', {
        marginTop: 30, fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 700, fontSize: d.saludo.length > 22 ? 92 : 112,
        lineHeight: 1.05, textAlign: 'center', justifyContent: 'center', maxWidth: 900,
      }, d.saludo),
    ),
    // Mitad de abajo
    h('div', { flexGrow: 1, flexDirection: 'column', alignItems: 'center', width: '100%', paddingTop: 60 },
      h('div', { fontSize: 36, lineHeight: 1.5, textAlign: 'center', justifyContent: 'center', maxWidth: 860 }, d.mensaje),
      d.horario ? h('div', { marginTop: 36 },
        pastilla(d.horario, { fondo: COLORES.manteca, color: COLORES.violeta, tam: 28, peso: 600, padY: 14, padX: 30 })) : null,
      h('div', { flexGrow: 1 }),
      h('div', { width: '100%', justifyContent: 'space-between', alignItems: 'flex-end' },
        h('div', { flexDirection: 'column', gap: 12, paddingBottom: 12 },
          lineaIcono('pin', DIRECCION_LOCAL, COLORES.violeta, 28),
          h('div', { fontSize: 28, fontWeight: 600, color: COLORES.lavanda }, USUARIO_IG)),
        logoConAro(120, COLORES.durazno),
      ),
    ),
  );
}

// --- HTML editable ---
//
// Cada slide se guarda como HTML con estilos en línea: es lo que Claude edita en el chat.
// Las plantillas arman el árbol, se serializa a HTML y se renderiza siempre desde ese HTML, así lo
// guardado y lo que se ve son exactamente lo mismo.

const SIN_UNIDAD = new Set(['flexGrow', 'flexShrink', 'flex', 'opacity', 'lineHeight', 'fontWeight', 'zIndex']);

function kebab(k) { return k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()); }
function camel(k) { return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function estiloACss(style = {}) {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${kebab(k)}:${typeof v === 'number' && !SIN_UNIDAD.has(k) ? `${v}px` : v}`)
    .join(';');
}

function arbolAHtml(nodo) {
  if (nodo === null || nodo === undefined || nodo === false) return '';
  if (Array.isArray(nodo)) return nodo.map(arbolAHtml).join('');
  if (typeof nodo === 'string' || typeof nodo === 'number') return escHtml(nodo);
  const { children, style, ...attrs } = nodo.props || {};
  let a = style && Object.keys(style).length ? ` style="${escHtml(estiloACss(style))}"` : '';
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) a += ` ${k}="${escHtml(v)}"`;
  if (nodo.type === 'img') return `<img${a}/>`;
  return `<${nodo.type}${a}>${arbolAHtml(children)}</${nodo.type}>`;
}

function decodificar(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l[0] === '#') return String.fromCodePoint(l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[l];
  });
}

// Normaliza lo que devuelve satori-html: decodifica entidades, pasa números a número y
// carga las imágenes (con caché compartida entre slides de una misma publicación)
async function prepararNodo(nodo, cache) {
  if (typeof nodo === 'string') return decodificar(nodo);
  if (!nodo || typeof nodo !== 'object') return nodo;
  const props = { ...nodo.props };
  if (props.style) {
    const st = {};
    for (const [k, v] of Object.entries(props.style)) {
      const key = k.includes('-') ? camel(k) : k;
      st[key] = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    }
    props.style = st;
  }
  if (nodo.type === 'img') {
    if (!cache.has(props.src)) cache.set(props.src, cargarImagen(props.src));
    const src = await cache.get(props.src);
    if (!src) throw new Error(`Imagen no disponible: ${String(props.src).slice(0, 80)}`);
    props.src = src;
  }
  const hijos = Array.isArray(props.children) ? props.children : props.children !== undefined ? [props.children] : [];
  props.children = await Promise.all(hijos.map((c) => prepararNodo(c, cache)));
  if (!props.children.length) delete props.children;
  return { type: nodo.type, props };
}

async function renderHtml(html, cache = new Map()) {
  let arbol = parsearHtml(html);
  // satori-html envuelve todo en un div contenedor: si hay un único elemento raíz, nos quedamos con ese
  const hijos = (arbol.props.children || []).filter((c) => typeof c !== 'string' || c.trim());
  if (hijos.length === 1 && typeof hijos[0] === 'object') arbol = hijos[0];
  const listo = await prepararNodo(arbol, cache);
  const svg = await satori(listo, { width: W, height: H, fonts: fuentes() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
}

// --- Render ---

const PLANTILLAS = {
  producto: slideProducto,
  unico_portada: unicoPortada,
  unico_detalle: unicoDetalle,
  unico_desarrolla: unicoDesarrolla,
  cierre,
  multi_portada: multiPortada,
  producto_imagen: productoImagen,
  institucional,
  festivo,
};

async function htmlDePlantilla(plantilla, datos) {
  const fn = PLANTILLAS[plantilla];
  if (!fn) throw new Error(`Plantilla desconocida: ${plantilla}`);
  return arbolAHtml(await fn(datos));
}

async function renderizar(plantilla, datos) {
  return renderHtml(await htmlDePlantilla(plantilla, datos));
}

module.exports = { renderizar, htmlDePlantilla, renderHtml, COLORES, W, H };
