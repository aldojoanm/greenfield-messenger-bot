// messenger/greenfield.js
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();
router.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// =======================
// Load JSON (robusto)
// =======================
function loadJSON(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function resolvePath(p) {
  if (!p) return null;
  // Si es absoluto, úsalo. Si no, resuélvelo desde el cwd real donde corre node.
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

const CFG_PATH = resolvePath(process.env.GREENFIELD_ADVISORS_JSON || './knowledge/greenfield_advisors.json');
const KEYWORDS_PATH = resolvePath(process.env.GREENFIELD_KEYWORDS_JSON || './knowledge/keywords.json');

let GF = loadJSON(CFG_PATH);
let KEYWORDS = loadJSON(KEYWORDS_PATH);

function reloadConfig() {
  const nextGF = loadJSON(CFG_PATH);
  if (nextGF) GF = nextGF;

  const nextK = loadJSON(KEYWORDS_PATH);
  if (nextK) KEYWORDS = nextK;
}
setInterval(reloadConfig, 2 * 60 * 1000);

// Logs de diagnóstico (una vez)
console.log('[Greenfield] CFG_PATH:', CFG_PATH);
console.log('[Greenfield] KEYWORDS_PATH:', KEYWORDS_PATH);
console.log(
  '[Greenfield] GF loaded:',
  !!GF,
  'departments:',
  GF?.departments?.length || 0,
  'advisors:',
  GF?.advisors ? Object.keys(GF.advisors).length : 0
);

// =======================
// Sesiones
// =======================
const SESSION_TTL_MS = 36 * 60 * 60 * 1000;
const SESSIONS_MAX = 800;
const sessions = new Map();

function newSession() {
  const now = Date.now();
  return {
    pending: null, // 'motivo' | 'dept' | 'dept_free' | 'scz_zone' | 'scz_zone_free' | 'ask_product' | 'ask_cultivo' | 'ask_problema'
    vars: {
      departamento: null,
      zona: null,
      motivo: null,
      producto: null,
      cultivo: null,
      problema: null,
    },
    profileName: null,
    flags: { greeted: false, justOpenedAt: 0, helpShownAt: 0 },
    lastPrompt: null,
    lastSeen: now,
    expiresAt: now + SESSION_TTL_MS,
  };
}

function getSession(psid) {
  let s = sessions.get(psid);
  if (!s) {
    s = newSession();
    sessions.set(psid, s);
  }
  s.lastSeen = Date.now();
  s.expiresAt = s.lastSeen + SESSION_TTL_MS;
  return s;
}

function clearSession(psid) {
  sessions.delete(psid);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if ((s.expiresAt || 0) <= now) sessions.delete(id);
  }
  if (sessions.size > SESSIONS_MAX) {
    const sorted = [...sessions.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
    const drop = sessions.size - SESSIONS_MAX;
    for (let i = 0; i < drop; i++) sessions.delete(sorted[i][0]);
  }
}, 10 * 60 * 1000);

// Anti-duplicados (MIDs)
const seenMIDs = [];
const seenSet = new Set();
function alreadyProcessed(mid) {
  if (!mid) return false;
  if (seenSet.has(mid)) return true;
  seenSet.add(mid);
  seenMIDs.push(mid);
  if (seenMIDs.length > 500) {
    const old = seenMIDs.shift();
    seenSet.delete(old);
  }
  return false;
}

// =======================
// Utils texto / normalización
// =======================
const norm = (t = '') => String(t || '')
  .toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^\p{L}\p{N}\s\-\+]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const title = s => String(s || '').replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
const clamp = (t, n = 20) => (t.length <= n ? t : t.slice(0, n - 1) + '…');

function shouldPrompt(s, key, ttlMs = 7000) {
  if (s.lastPrompt && s.lastPrompt.key === key && Date.now() - s.lastPrompt.at < ttlMs) return false;
  s.lastPrompt = { key, at: Date.now() };
  return true;
}

function resetFlowKeepZone(s) {
  s.pending = null;
  s.vars.motivo = null;
  s.vars.producto = null;
  s.vars.cultivo = null;
  s.vars.problema = null;
}

// =======================
// FB Send API helpers
// =======================
async function httpFetchAny(...args) {
  const f = globalThis.fetch || (await import('node-fetch')).default;
  return f(...args);
}

async function sendText(psid, text) {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = { recipient: { id: psid }, message: { text: String(text).slice(0, 2000) } };
  const r = await httpFetchAny(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error('sendText', await r.text());
}

// ✅ NUNCA manda quick_replies vacío → evita (#194)
async function sendQR(psid, text, options = []) {
  const quick_replies = (options || [])
    .slice(0, 11)
    .map(o => {
      if (typeof o === 'string') {
        return { content_type: 'text', title: clamp(o), payload: `QR_${o.replace(/\s+/g, '_').toUpperCase()}` };
      }
      return {
        content_type: 'text',
        title: clamp(o.title),
        payload: o.payload || `QR_${String(o.title || '').replace(/\s+/g, '_').toUpperCase()}`,
      };
    })
    .filter(Boolean);

  if (quick_replies.length === 0) {
    await sendText(psid, String(text).slice(0, 2000));
    return;
  }

  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = { recipient: { id: psid }, message: { text, quick_replies } };
  const r = await httpFetchAny(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error('sendQR', await r.text());
}

async function sendButtons(psid, text, buttons = []) {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: String(text).slice(0, 640),
          buttons: (buttons || []).slice(0, 3).map(b => {
            if (b.type === 'web_url') return { type: 'web_url', url: b.url, title: clamp(b.title) };
            if (b.type === 'postback') return { type: 'postback', payload: String(b.payload).slice(0, 1000), title: clamp(b.title) };
            return null;
          }).filter(Boolean),
        },
      },
    },
  };
  const r = await httpFetchAny(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error('sendButtons', await r.text());
}

async function sendGenericCards(psid, elements = []) {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: { template_type: 'generic', elements: (elements || []).slice(0, 10) },
      },
    },
  };
  const r = await httpFetchAny(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error('sendGenericCards', await r.text());
}

// =======================
// Perfil usuario
// =======================
async function fetchFBProfileName(psid) {
  const urlBase = `https://graph.facebook.com/v20.0/${psid}`;
  const qs = `fields=first_name,last_name,name&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

  async function tryOnce() {
    const r = await httpFetchAny(`${urlBase}?${qs}`);
    if (!r.ok) return null;
    const j = await r.json();
    const fn = (j.first_name || '').trim();
    const ln = (j.last_name || '').trim();
    let raw = [fn, ln].filter(Boolean).join(' ').trim();
    if (!raw && j.name) raw = String(j.name).trim();
    return raw ? title(raw).slice(0, 80) : null;
  }

  const first = await tryOnce();
  if (first) return first;
  await new Promise(res => setTimeout(res, 250));
  return await tryOnce();
}

async function ensureProfileName(psid) {
  const s = getSession(psid);
  if (s.profileName) return s.profileName;
  const n = await fetchFBProfileName(psid);
  if (n) s.profileName = n;
  return s.profileName || null;
}

// =======================
// Config helpers + fallback
// =======================
function hasGFData() {
  return !!(GF && Array.isArray(GF.departments) && GF.departments.length > 0 && GF.advisors && Object.keys(GF.advisors).length > 0);
}

function getDepartments() { return (GF?.departments || []); }
function getAdvisorsMap() { return GF?.advisors || {}; }
function getAdvisorById(id) { return getAdvisorsMap()?.[id] || null; }

function getDeptZones(deptId) {
  const d = getDepartments().find(x => x.id === deptId);
  return d?.zones || [];
}
function findDeptById(id) { return getDepartments().find(d => d.id === id) || null; }
function findZoneById(deptId, zoneId) { return getDeptZones(deptId).find(z => z.id === zoneId) || null; }

function detectSczZoneByKeywords(text) {
  const t = norm(text);
  const scz = getDepartments().find(d => d.id === 'santa_cruz');
  if (!scz?.zones) return null;
  for (const z of scz.zones) {
    const kws = z.keywords || [];
    if (kws.some(k => t.includes(norm(k)))) return z;
  }
  return null;
}

// Resolver images (Messenger necesita URL absoluta)
function resolveImageUrl(p) {
  const raw = String(p || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = (GF?.brand?.assets_base_url || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  const pth = raw.startsWith('/') ? raw : `/${raw}`;
  return `${base}${pth}`;
}

// =======================
// WhatsApp link + mensaje armado
// =======================
function waLink(phone, msg) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits.replace(/^\+/, '')}?text=${encodeURIComponent(msg)}`;
}

function motivosList() {
  return GF?.handoff?.motivos || [
    { id: 'precio_pedido', label: 'Precio / Pedido' },
    { id: 'ficha_tecnica', label: 'Ficha técnica / Etiqueta' },
    { id: 'consulta_tecnica', label: 'Consulta técnica (cultivo/plaga)' },
    { id: 'disponibilidad', label: 'Disponibilidad / Stock' },
  ];
}

function renderWhatsAppMessage(s, motivoLabel = '') {
  const tpl = GF?.brand?.whatsapp_message_template
    || 'Hola, soy {{client_name}}. Te escribo desde *{{departamento}}* (zona: *{{zona}}*). Necesito ayuda con: *{{motivo}}*. {{extra}}';

  const extraParts = [];
  if (s.vars.producto) extraParts.push(`Producto: *${s.vars.producto}*.`);
  if (s.vars.cultivo) extraParts.push(`Cultivo: *${s.vars.cultivo}*.`);
  if (s.vars.problema) extraParts.push(`Problema: *${s.vars.problema}*.`);
  const extra = extraParts.join(' ');

  return tpl
    .replaceAll('{{client_name}}', s.profileName || 'Cliente')
    .replaceAll('{{departamento}}', s.vars.departamento || 'ND')
    .replaceAll('{{zona}}', s.vars.zona || 'ND')
    .replaceAll('{{motivo}}', motivoLabel || s.vars.motivo || 'Consulta')
    .replaceAll('{{extra}}', extra || '');
}

// =======================
// MENÚ PRINCIPAL (BOTONES)
// =======================
async function showMainMenu(psid) {
  await sendButtons(psid, '¿En qué te puedo ayudar hoy? 👇', [
    { type: 'postback', title: '🧪 Nuestros productos', payload: 'GF_PRODUCTS' },
    { type: 'postback', title: '👨‍🌾 Hablar con un agrónomo', payload: 'GF_AGRO' },
    { type: 'postback', title: '📌 Ayuda rápida', payload: 'GF_HELP' },
  ]);
}

// =======================
// AYUDA RÁPIDA (10)
// =======================
const QUICK_HELP = [
  { title: '💰 Precio / pedido', payload: 'GF_HELP_PRECIO' },
  { title: '📦 Stock / disponibilidad', payload: 'GF_HELP_STOCK' },
  { title: '🚚 Envíos / cobertura', payload: 'GF_HELP_ENVIO' },
  { title: '🧾 Factura / NIT', payload: 'GF_HELP_FACTURA' },
  { title: '💳 Crédito / plazo', payload: 'GF_HELP_CREDITO' },
  { title: '📍 Ubicación', payload: 'GF_HELP_UBICACION' },
  { title: '🕒 Horarios', payload: 'GF_HELP_HORARIOS' },
  { title: '🧪 Recomendar producto', payload: 'GF_HELP_RECOMENDAR' },
  { title: '🐛 Plaga / maleza / hongo', payload: 'GF_HELP_PLAGA' },
  { title: '👨‍🌾 Hablar con un agrónomo', payload: 'GF_AGRO' },
];

async function showHelp(psid) {
  const s = getSession(psid);
  const COOLDOWN = 5000;
  if (Date.now() - (s.flags.helpShownAt || 0) < COOLDOWN) return;
  s.flags.helpShownAt = Date.now();
  await sendQR(psid, '📌 Ayuda rápida — elige una opción:', QUICK_HELP);
}

// =======================
// Flujo Agrónomo
// =======================
async function askMotivo(psid) {
  const s = getSession(psid);
  s.pending = 'motivo';
  if (!shouldPrompt(s, 'askMotivo')) return;

  await sendQR(psid, 'Primero dime qué necesitas 👇', motivosList().map(m => ({
    title: m.label,
    payload: `GF_MOTIVO_${m.id}`
  })));
}

async function askDepartamento(psid) {
  const s = getSession(psid);

  // ✅ Si no hay config, pedir texto libre (no trabar)
  if (!hasGFData()) {
    s.pending = 'dept_free';
    await sendText(psid, 'Para asignarte al ingeniero correcto, escribe tu *departamento* y *zona/ciudad*.\nEj: "Santa Cruz, Montero"');
    await showMainMenu(psid);
    return;
  }

  s.pending = 'dept';
  if (!shouldPrompt(s, 'askDepartamento')) return;

  const deps = getDepartments();
  if (!deps.length) {
    s.pending = 'dept_free';
    await sendText(psid, 'Escribe tu *departamento* (ej: Santa Cruz / Cochabamba / La Paz).');
    await showMainMenu(psid);
    return;
  }

  await sendQR(psid, '¿De qué *departamento* nos escribes?', deps.map(d => ({
    title: d.name,
    payload: `GF_DEPT_${d.id}`
  })));
}

async function askSczZone(psid) {
  const s = getSession(psid);

  if (!hasGFData()) {
    s.pending = 'scz_zone_free';
    await sendText(psid, 'En Santa Cruz, ¿de qué *zona* eres?\nEj: Montero / Warnes / San Julián / 4 Cañadas / Roboré / Samaipata');
    await showMainMenu(psid);
    return;
  }

  s.pending = 'scz_zone';
  if (!shouldPrompt(s, 'askSczZone')) return;

  const zones = getDeptZones('santa_cruz');
  if (!zones.length) {
    s.pending = 'scz_zone_free';
    await sendText(psid, 'Escribe tu *zona de Santa Cruz* (ej: Montero / Warnes / San Julián / Roboré).');
    await showMainMenu(psid);
    return;
  }

  await sendQR(psid, 'En Santa Cruz, ¿en qué *zona* estás?', zones.map(z => ({
    title: z.name,
    payload: `GF_SCZ_ZONE_${z.id}`
  })));
}

async function askProduct(psid) {
  const s = getSession(psid);
  s.pending = 'ask_product';
  if (!shouldPrompt(s, 'askProduct')) return;
  await sendText(psid, '¿Qué *producto* te interesa? (Escribe el nombre como lo recuerdes)');
}

async function askCultivo(psid) {
  const s = getSession(psid);
  s.pending = 'ask_cultivo';
  if (!shouldPrompt(s, 'askCultivo')) return;
  await sendText(psid, '1) ¿Qué *cultivo* manejas? (ej: soya/maíz/arroz/caña)');
}

async function askProblema(psid) {
  const s = getSession(psid);
  s.pending = 'ask_problema';
  if (!shouldPrompt(s, 'askProblema')) return;
  await sendText(psid, '2) ¿Qué *problema* tienes? (plaga/maleza/enfermedad/síntoma)');
}

function advisorIdsForCurrentZone(s) {
  if (!s.vars.departamento) return [];

  const dept = getDepartments().find(d => d.name === s.vars.departamento) || null;
  if (!dept) return [];

  if (dept.id !== 'santa_cruz') return dept.advisorIds || [];

  if (!s.vars.zona) return [];
  const z = (dept.zones || []).find(x => x.name === s.vars.zona) || null;
  return z?.advisorIds || [];
}

function pickFallbackAdvisor() {
  if (GF?.advisors) {
    const arr = Object.values(GF.advisors);
    if (arr.length) return arr[0];
  }
  return null;
}

async function showAdvisorsForCurrentZone(psid) {
  const s = getSession(psid);

  // Si no hay config, contacto genérico si existe
  if (!hasGFData()) {
    const a = pickFallbackAdvisor();
    await ensureProfileName(psid);
    const motivoLabel = motivosList().find(x => x.id === s.vars.motivo)?.label || 'Consulta';
    const msg = renderWhatsAppMessage(s, motivoLabel);

    if (a?.whatsapp) {
      const url = waLink(a.whatsapp, msg);
      await sendButtons(psid, '✅ Te dejo un contacto directo:', [
        { type: 'web_url', url, title: '📲 WhatsApp' }
      ]);
      resetFlowKeepZone(s);
      await showMainMenu(psid);
      return;
    }

    await sendText(psid, '✅ Listo. Un asesor te contactará a la brevedad.');
    resetFlowKeepZone(s);
    await showMainMenu(psid);
    return;
  }

  const ids = advisorIdsForCurrentZone(s);

  if (!ids.length) {
    await sendText(psid, 'No encontré un agrónomo asignado a esa zona aún. Probemos de nuevo 👇');
    s.vars.departamento = null;
    s.vars.zona = null;
    await askDepartamento(psid);
    return;
  }

  const motivoLabel = motivosList().find(x => x.id === s.vars.motivo)?.label || 'Consulta';
  const msg = renderWhatsAppMessage(s, motivoLabel);

  const elements = [];
  for (const id of ids.slice(0, 10)) {
    const a = getAdvisorById(id);
    if (!a) continue;

    const url = waLink(a.whatsapp, msg);
    const subtitle = [a.role || null, a.coverage_note || null].filter(Boolean).join(' • ').slice(0, 80);
    const img = resolveImageUrl(a.image);

    elements.push({
      title: String(a.name || 'Ingeniero Agrónomo').slice(0, 80),
      subtitle: subtitle || 'Atención por zona',
      image_url: img || undefined,
      buttons: url ? [{ type: 'web_url', url, title: '📲 Contactar por WhatsApp' }] : [],
    });
  }

  await sendText(psid, `Listo${s.profileName ? ` ${s.profileName}` : ''} ✅\nTe dejo el *contacto directo* del ingeniero agrónomo de tu zona:`);
  await sendGenericCards(psid, elements);

  await sendText(psid, 'Si necesitas algo más, usa el menú 😊');
  resetFlowKeepZone(s);
  await showMainMenu(psid);
}

async function startAgronomoFlow(psid) {
  const s = getSession(psid);
  if (!s.profileName) await ensureProfileName(psid);

  if (!s.vars.motivo) return askMotivo(psid);

  // extras SOLO para armar el mensaje (no responder fichas/precios)
  if (s.vars.motivo === 'ficha_tecnica' && !s.vars.producto) return askProduct(psid);
  if (s.vars.motivo === 'consulta_tecnica') {
    if (!s.vars.cultivo) return askCultivo(psid);
    if (!s.vars.problema) return askProblema(psid);
  }

  if (!s.vars.departamento) return askDepartamento(psid);
  if (s.vars.departamento === 'Santa Cruz' && !s.vars.zona) return askSczZone(psid);

  return showAdvisorsForCurrentZone(psid);
}

// =======================
// Router global (intenciones)
// =======================
const isGreeting = (t = '') => /\b(hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hello|hey|hi)\b/.test(norm(t));
const isEnd = (t = '') => /\b(chau|chao|adios|adiós|bye|finalizar|salir|eso es todo|nada mas|nada más)\b/.test(norm(t));

function detectIntent(text) {
  const t = norm(text);
  if (!t) return null;

  if (isGreeting(t)) return { type: 'GREET' };
  if (isEnd(t)) return { type: 'END' };

  if (/(productos|catalogo|catálogo|portafolio|lista de productos|que venden|que ofrecen)/.test(t)) return { type: 'PRODUCTS' };
  if (/(asesor|agronomo|agrónomo|ingeniero|hablar con|contacto|whatsapp|wsp|numero|tel(e|é)fono)/.test(t)) return { type: 'AGRO' };
  if (/(precio|presio|cotizar|proforma|pedido|comprar|venta|cuanto cuesta|cuanto vale)/.test(t)) return { type: 'MOTIVO', motivo: 'precio_pedido' };
  if (/(ficha|etiqueta|msds|hoja de seguridad|ingrediente|dosis|toxicidad|antidoto|antídoto)/.test(t)) return { type: 'MOTIVO', motivo: 'ficha_tecnica' };
  if (/(stock|disponible|disponibilidad|agotado|cuando llega|cu(a|á)ndo llega)/.test(t)) return { type: 'MOTIVO', motivo: 'disponibilidad' };
  if (/(plaga|maleza|hongo|roya|oruga|trips|pulgon|pulgón|gusano|enfermedad|mancha|se me muere|se me esta muriendo|se me está muriendo)/.test(t)) return { type: 'MOTIVO', motivo: 'consulta_tecnica' };
  if (/(ayuda|help|no entiendo|explica|como hago|cómo hago)/.test(t)) return { type: 'HELP' };

  return null;
}

// =======================
// Keywords.json fallback (opcional)
// =======================
function getKeywordItems() {
  const items = KEYWORDS?.items;
  return Array.isArray(items) ? items : [];
}
function detectKeywordHit(text) {
  const t = norm(text);
  if (!t) return null;

  const candidates = [];
  for (const it of getKeywordItems()) {
    const pats = Array.isArray(it?.patterns) ? it.patterns : [];
    for (const p of pats) {
      const pn = norm(p);
      if (!pn || pn.length < 2) continue;
      if (t.includes(pn)) candidates.push({ it, len: pn.length, pr: Number(it.priority || 0) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.pr - a.pr) || (b.len - a.len));
  return candidates[0].it || null;
}

async function runKeywordAction(psid, kwItem) {
  const s = getSession(psid);
  const replyText = kwItem?.reply?.text ? String(kwItem.reply.text) : null;
  const actionType = kwItem?.action?.type || 'NONE';

  if (replyText) await sendText(psid, replyText);

  if (actionType === 'SHOW_MAIN_MENU') { await showMainMenu(psid); return true; }
  if (actionType === 'END_SESSION') { await sendText(psid, '¡Gracias por escribirnos! 👋'); clearSession(psid); return true; }
  if (actionType === 'OPEN_AGRONOMO') { await startAgronomoFlow(psid); return true; }
  if (actionType === 'ASK_PRODUCT_THEN_AGRONOMO') { s.vars.motivo = 'ficha_tecnica'; await askProduct(psid); return true; }
  if (actionType === 'ASK_CULTIVO_PROBLEMA_THEN_AGRONOMO') { s.vars.motivo = 'consulta_tecnica'; await askCultivo(psid); return true; }

  return false;
}

// =======================
// Saludo profesional
// =======================
async function greetAndMenu(psid) {
  const s = getSession(psid);
  s.flags.greeted = true;
  s.flags.justOpenedAt = Date.now();
  await ensureProfileName(psid);

  await sendText(
    psid,
    `👋 ¡Hola${s.profileName ? ` ${s.profileName}` : ''}! Bienvenido a *Greenfield*.\n` +
    `Puedo ayudarte a *llegar al ingeniero agrónomo* de tu zona y dejar el *WhatsApp listo* con tu consulta.\n` +
    `✅ No enviamos precios, cotizaciones ni fichas por este chat.`
  );

  await showMainMenu(psid);
}

// =======================
// WEBHOOK verify
// =======================
router.get('/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// =======================
// WEBHOOK main
// =======================
router.post('/webhook', async (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);

    for (const entry of req.body.entry || []) {
      for (const ev of entry.messaging || []) {
        const psid = ev?.sender?.id;
        if (!psid) continue;

        const mid = ev.message?.mid || ev.postback?.mid || null;
        if (alreadyProcessed(mid)) continue;
        if (ev.message?.is_echo) continue;

        const s = getSession(psid);

        const payload = (ev.postback?.payload || '').trim();
        const textMsg = (ev.message?.text || '').trim();
        const qrPayload = ev.message?.quick_reply?.payload || null;

        const isGetStarted =
          payload === 'GET_STARTED'
          || (ev.referral && ev.referral.type === 'OPEN_THREAD')
          || !!ev.optin;

        if (isGetStarted) {
          await greetAndMenu(psid);
          continue;
        }

        const incoming = qrPayload || payload || textMsg || '';

        // =======================
        // PENDINGS de texto libre (fallback config)
        // =======================
        if (s.pending === 'dept_free') {
          const t = String(textMsg || '').trim();
          if (t.length >= 2) {
            s.vars.departamento = title(t).slice(0, 40);
            s.pending = null;

            // Si menciona SCZ, intentar detectar zona por keywords si config existe
            if (/santa cruz|scz/i.test(t)) {
              s.vars.departamento = 'Santa Cruz';
              if (hasGFData()) {
                const z = detectSczZoneByKeywords(t);
                if (z) s.vars.zona = z.name;
              }
              if (!s.vars.zona) return askSczZone(psid);
            }

            await startAgronomoFlow(psid);
            continue;
          }
        }

        if (s.pending === 'scz_zone_free') {
          const t = String(textMsg || '').trim();
          if (t.length >= 2) {
            s.vars.zona = title(t).slice(0, 60);
            s.pending = null;
            await startAgronomoFlow(psid);
            continue;
          }
        }

        if (s.pending === 'ask_product') {
          const t = String(textMsg || '').trim();
          if (t.length >= 2) {
            s.vars.producto = title(t).slice(0, 60);
            s.pending = null;
            await startAgronomoFlow(psid);
            continue;
          }
        }

        if (s.pending === 'ask_cultivo') {
          const t = String(textMsg || '').trim();
          if (t.length >= 2) {
            s.vars.cultivo = title(t).slice(0, 40);
            s.pending = null;
            await askProblema(psid);
            continue;
          }
        }

        if (s.pending === 'ask_problema') {
          const t = String(textMsg || '').trim();
          if (t.length >= 2) {
            s.vars.problema = t.slice(0, 120);
            s.pending = null;
            await startAgronomoFlow(psid);
            continue;
          }
        }

        // =======================
        // PAYLOADS GF_
        // =======================
        if (typeof incoming === 'string' && incoming.startsWith('GF_')) {

          if (incoming === 'GF_HELP') { await showHelp(psid); continue; }

          if (incoming === 'GF_PRODUCTS') {
            const url = GF?.brand?.products_url || 'https://greenfield.com.bo/productos/';
            await sendButtons(psid, '🧪 Nuestros productos 👇', [{ type: 'web_url', url, title: 'Ver productos' }]);
            await showMainMenu(psid);
            continue;
          }

          if (incoming === 'GF_AGRO') {
            await startAgronomoFlow(psid);
            continue;
          }

          // Ayuda rápida
          if (incoming === 'GF_HELP_PRECIO') { s.vars.motivo = 'precio_pedido'; await startAgronomoFlow(psid); continue; }
          if (incoming === 'GF_HELP_STOCK') { s.vars.motivo = 'disponibilidad'; await startAgronomoFlow(psid); continue; }
          if (incoming === 'GF_HELP_ENVIO') { s.vars.motivo = 'precio_pedido'; await startAgronomoFlow(psid); continue; }
          if (incoming === 'GF_HELP_FACTURA') { s.vars.motivo = 'precio_pedido'; await startAgronomoFlow(psid); continue; }
          if (incoming === 'GF_HELP_CREDITO') { s.vars.motivo = 'precio_pedido'; await startAgronomoFlow(psid); continue; }

          if (incoming === 'GF_HELP_UBICACION') {
            await sendText(psid, GF?.brand?.location_text || '📍 Para ubicación, escribe tu ciudad y te conecto con el ingeniero de tu zona.');
            s.vars.motivo = 'precio_pedido';
            await startAgronomoFlow(psid);
            continue;
          }
          if (incoming === 'GF_HELP_HORARIOS') {
            await sendText(psid, GF?.brand?.hours_text || '🕒 Los horarios te los confirma el ingeniero agrónomo de tu zona.');
            s.vars.motivo = 'precio_pedido';
            await startAgronomoFlow(psid);
            continue;
          }
          if (incoming === 'GF_HELP_RECOMENDAR') {
            s.vars.motivo = 'consulta_tecnica';
            await askCultivo(psid);
            continue;
          }
          if (incoming === 'GF_HELP_PLAGA') {
            s.vars.motivo = 'consulta_tecnica';
            await askCultivo(psid);
            continue;
          }

          // Motivo
          if (incoming.startsWith('GF_MOTIVO_')) {
            const id = incoming.replace('GF_MOTIVO_', '');
            s.vars.motivo = id;
            await startAgronomoFlow(psid);
            continue;
          }

          // Depto
          if (incoming.startsWith('GF_DEPT_')) {
            const id = incoming.replace('GF_DEPT_', '');
            const dept = findDeptById(id);
            if (!dept) { await askDepartamento(psid); continue; }

            s.vars.departamento = dept.name;
            s.vars.zona = null;
            s.pending = null;

            if (dept.id === 'santa_cruz') await askSczZone(psid);
            else await startAgronomoFlow(psid);

            continue;
          }

          // Zona SCZ
          if (incoming.startsWith('GF_SCZ_ZONE_')) {
            const zoneId = incoming.replace('GF_SCZ_ZONE_', '');
            const zone = findZoneById('santa_cruz', zoneId);
            if (!zone) { await askSczZone(psid); continue; }

            s.vars.departamento = 'Santa Cruz';
            s.vars.zona = zone.name;
            s.pending = null;

            await startAgronomoFlow(psid);
            continue;
          }
        }

        // =======================
        // Router global por texto
        // =======================
        const intent = detectIntent(textMsg);

        if (intent?.type === 'GREET') {
          if (!s.flags.greeted) await greetAndMenu(psid);
          else await showMainMenu(psid);
          continue;
        }

        if (intent?.type === 'END') {
          await sendText(psid, '¡Gracias por escribirnos! 👋');
          clearSession(psid);
          continue;
        }

        if (intent?.type === 'PRODUCTS') {
          const url = GF?.brand?.products_url || 'https://greenfield.com.bo/productos/';
          await sendButtons(psid, '🧪 Nuestros productos 👇', [{ type: 'web_url', url, title: 'Ver productos' }]);
          await showMainMenu(psid);
          continue;
        }

        if (intent?.type === 'HELP') {
          await showHelp(psid);
          continue;
        }

        if (intent?.type === 'AGRO') {
          await startAgronomoFlow(psid);
          continue;
        }

        if (intent?.type === 'MOTIVO') {
          s.vars.motivo = intent.motivo;
          await startAgronomoFlow(psid);
          continue;
        }

        // =======================
        // Keywords fallback (opcional)
        // =======================
        const kwHit = detectKeywordHit(textMsg);
        if (kwHit) {
          const handled = await runKeywordAction(psid, kwHit);
          if (handled) continue;
        }

        // =======================
        // Default
        // =======================
        if (!s.flags.greeted) {
          await greetAndMenu(psid);
          continue;
        }

        await sendText(
          psid,
          'Te entiendo 😊\n' +
          'Usa el menú o dime si tu consulta es por:\n' +
          '• *Precio/Pedido*\n' +
          '• *Stock/Disponibilidad*\n' +
          '• *Consulta técnica* (cultivo + problema)\n' +
          'y te dejo el contacto del *ingeniero agrónomo* de tu zona.'
        );
        await showMainMenu(psid);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('❌ /webhook messenger', e);
    res.sendStatus(500);
  }
});

export default router;
