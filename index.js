// index.js (Messenger webhook + menú Greenfield)
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
router.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';

// ======================================
// Paths robustos (Railway/Node ESM)
// ======================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizePath(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

function pickExistingFile(candidates = []) {
  for (const c of candidates.filter(Boolean)) {
    const abs = normalizePath(c);
    try {
      if (abs && fs.existsSync(abs)) return abs;
    } catch {}
  }
  return null;
}

const CFG_PATH = pickExistingFile([
  process.env.GREENFIELD_ADVISORS_JSON,
  path.join(__dirname, 'knowledge', 'greenfield_advisors.json'),
  path.join(process.cwd(), 'knowledge', 'greenfield_advisors.json'),
  path.join(__dirname, 'knowledge', 'advisors.json'),
  path.join(process.cwd(), 'knowledge', 'advisors.json'),
]);

const KEYWORDS_PATH = pickExistingFile([
  process.env.GREENFIELD_KEYWORDS_JSON,
  path.join(__dirname, 'knowledge', 'keywords.json'),
  path.join(process.cwd(), 'knowledge', 'keywords.json'),
]);

function loadJSON(p) {
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Greenfield] loadJSON ERROR:', p, e?.code || '', e?.message || e);
    return null;
  }
}

function isValidGF(obj) {
  const okDeps = Array.isArray(obj?.departments) && obj.departments.length > 0;
  const okAdv = obj?.advisors && typeof obj.advisors === 'object' && Object.keys(obj.advisors).length > 0;
  return okDeps && okAdv;
}

let GF = loadJSON(CFG_PATH);
let KEYWORDS = loadJSON(KEYWORDS_PATH);

let gfStatus = {
  cfgPath: CFG_PATH,
  keywordsPath: KEYWORDS_PATH,
  loadedAt: Date.now(),
  gfOk: !!GF && isValidGF(GF),
  gfDepartments: Array.isArray(GF?.departments) ? GF.departments.length : 0,
  gfAdvisors: GF?.advisors ? Object.keys(GF.advisors).length : 0,
};

function refreshStatus() {
  gfStatus = {
    cfgPath: CFG_PATH,
    keywordsPath: KEYWORDS_PATH,
    loadedAt: Date.now(),
    gfOk: !!GF && isValidGF(GF),
    gfDepartments: Array.isArray(GF?.departments) ? GF.departments.length : 0,
    gfAdvisors: GF?.advisors ? Object.keys(GF.advisors).length : 0,
  };
}

function reloadConfig() {
  const nextGF = loadJSON(CFG_PATH);
  if (nextGF) GF = nextGF;

  const nextK = loadJSON(KEYWORDS_PATH);
  if (nextK) KEYWORDS = nextK;

  refreshStatus();

  if (GF && !gfStatus.gfOk) {
    console.error(
      '[Greenfield] CFG cargó pero es inválido (faltan departments/advisors). Revisá que sea el JSON correcto:',
      gfStatus.cfgPath
    );
  }
}

reloadConfig();
setInterval(reloadConfig, 2 * 60 * 1000);

console.log('[Greenfield] CFG_PATH:', CFG_PATH || '(NO ENCONTRADO)');
console.log('[Greenfield] KEYWORDS_PATH:', KEYWORDS_PATH || '(NO ENCONTRADO)');
console.log('[Greenfield] GF ok:', gfStatus.gfOk, 'departments:', gfStatus.gfDepartments, 'advisors:', gfStatus.gfAdvisors);

// Export para /debug/config
export function runtimeDebug() {
  return {
    cwd: process.cwd(),
    __dirname,
    cfgPath: gfStatus.cfgPath,
    keywordsPath: gfStatus.keywordsPath,
    gfOk: gfStatus.gfOk,
    departments: gfStatus.gfDepartments,
    advisors: gfStatus.gfAdvisors,
    loadedAt: new Date(gfStatus.loadedAt).toISOString(),
  };
}

// =======================
// Sesiones
// =======================
const SESSION_TTL_MS = 36 * 60 * 60 * 1000;
const SESSIONS_MAX = 800;
const sessions = new Map();

function newSession() {
  const now = Date.now();
  return {
    pending: null,
    vars: { departamento: null, zona: null },
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
// Utils texto
// =======================
const norm = (t = '') => String(t || '')
  .toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^\p{L}\p{N}\s\-\+]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const title = s => String(s || '').replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
const clamp = (t, n = 20) => (t.length <= n ? t : t.slice(0, n - 1) + '…');

// =======================
// FB Send API
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

  if (quick_replies.length === 0) return sendText(psid, String(text).slice(0, 2000));

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
  const clean = (elements || []).slice(0, 10).map(el => {
    const x = { ...el };
    delete x.subtitle;
    return x;
  });

  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          image_aspect_ratio: 'square',
          elements: clean,
        },
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

// Cache simple de attachment_id por URL (para no re-subir siempre)
const ATTACH_CACHE = new Map(); // imageUrl -> { id, at }
const ATTACH_TTL_MS = 24 * 60 * 60 * 1000;

function getCachedAttachment(imageUrl) {
  const it = ATTACH_CACHE.get(imageUrl);
  if (!it) return null;
  if (Date.now() - it.at > ATTACH_TTL_MS) {
    ATTACH_CACHE.delete(imageUrl);
    return null;
  }
  return it.id || null;
}

function setCachedAttachment(imageUrl, id) {
  if (!imageUrl || !id) return;
  ATTACH_CACHE.set(imageUrl, { id, at: Date.now() });
}

async function uploadReusableImage(imageUrl) {
  const cached = getCachedAttachment(imageUrl);
  if (cached) return cached;

  const url = `https://graph.facebook.com/v20.0/me/message_attachments?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = {
    message: {
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: true },
      },
    },
  };

  const r = await httpFetchAny(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const txt = await r.text();
  if (!r.ok) throw new Error(`uploadReusableImage failed: ${txt}`);

  const j = JSON.parse(txt);
  const attachmentId = j?.attachment_id;
  if (!attachmentId) throw new Error(`uploadReusableImage no attachment_id: ${txt}`);

  setCachedAttachment(imageUrl, attachmentId);
  return attachmentId;
}

async function sendMediaCard(psid, imageUrl, buttonUrl, buttonTitle = 'Contactar por WhatsApp') {
  const attachment_id = await uploadReusableImage(imageUrl);

  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'media',
          elements: [
            {
              media_type: 'image',
              attachment_id,
              buttons: [{ type: 'web_url', url: buttonUrl, title: clamp(buttonTitle, 20) }],
            },
          ],
        },
      },
    },
  };

  const r = await httpFetchAny(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!r.ok) console.error('sendMediaCard', await r.text());
}

async function sendMediaCard(psid, imageUrl, buttonUrl, buttonTitle = 'Contactar por WhatsApp') {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'media',
          elements: [
            {
              media_type: 'image',
              url: imageUrl,
              buttons: [
                { type: 'web_url', url: buttonUrl, title: clamp(buttonTitle, 20) },
              ],
            },
          ],
        },
      },
    },
  };

  const r = await httpFetchAny(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error('sendMediaCard', await r.text());
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
// Config helpers
// =======================
function hasGFData() {
  return !!(GF && isValidGF(GF));
}

function getDepartments() { return (GF?.departments || []); }
function getDeptZones(deptId) {
  const d = getDepartments().find(x => x.id === deptId);
  return d?.zones || [];
}
function findDeptById(id) { return getDepartments().find(d => d.id === id) || null; }
function findZoneById(deptId, zoneId) { return getDeptZones(deptId).find(z => z.id === zoneId) || null; }

function getAdvisorsMap() { return GF?.advisors || {}; }
function getAdvisorById(id) { return getAdvisorsMap()?.[id] || null; }

// IMPORTANTE: assets_base_url debe ser TU dominio Railway
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
// WhatsApp link
// =======================
function waLink(phone, msg) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits.replace(/^\+/, '')}?text=${encodeURIComponent(msg || '')}`;
}

function buildDefaultWhatsAppMessage(s) {
  const tpl = GF?.brand?.whatsapp_message_template
    || 'Hola, soy {{client_name}}. Te escribo desde *{{departamento}}* (zona: *{{zona}}*). Necesito ayuda con: *{{motivo}}*.';

  return tpl
    .replaceAll('{{client_name}}', s.profileName || 'Cliente')
    .replaceAll('{{departamento}}', s.vars.departamento || 'ND')
    .replaceAll('{{zona}}', s.vars.zona || 'ND')
    .replaceAll('{{motivo}}', 'Consulta')
    .replaceAll('{{extra}}', '');
}

// =======================
// MENÚ PRINCIPAL
// =======================
async function showMainMenu(psid) {
  await sendButtons(psid, '¿En qué te puedo ayudar hoy? 👇', [
    { type: 'postback', title: 'Nuestros productos', payload: 'GF_PRODUCTS' },
    { type: 'postback', title: '👨‍🌾 Hablar con un asesor', payload: 'GF_AGRO' },
    { type: 'postback', title: '📌 Ayuda rápida', payload: 'GF_HELP' },
  ]);
}

// =======================
// AYUDA RÁPIDA
// =======================
const QUICK_HELP = [
  { title: '💰 Precio / pedido', payload: 'GF_HELP_PRECIO' },
  { title: '📦 Stock / disponibilidad', payload: 'GF_HELP_STOCK' },
  { title: '🚚 Envíos / cobertura', payload: 'GF_HELP_ENVIO' },
  { title: '🧾 Factura / NIT', payload: 'GF_HELP_FACTURA' },
  { title: '💳 Crédito / plazo', payload: 'GF_HELP_CREDITO' },
  { title: '📍 Ubicación', payload: 'GF_HELP_UBICACION' },
  { title: '🕒 Horarios', payload: 'GF_HELP_HORARIOS' },
  { title: 'Recomendar producto', payload: 'GF_HELP_RECOMENDAR' },
  { title: '🐛 Plaga / maleza / hongo', payload: 'GF_HELP_PLAGA' },
  { title: '👨‍🌾 Hablar con un asesor', payload: 'GF_AGRO' },
];

async function showHelp(psid) {
  const s = getSession(psid);
  const COOLDOWN = 5000;
  if (Date.now() - (s.flags.helpShownAt || 0) < COOLDOWN) return;
  s.flags.helpShownAt = Date.now();
  await sendQR(psid, '📌 Ayuda rápida — elige una opción:', QUICK_HELP);
}

// =======================
// Flujo asesor
// =======================
function pickFallbackAdvisor() {
  const arr = Object.values(getAdvisorsMap() || {});
  return arr.length ? arr[0] : null;
}

async function startAdvisorFlow(psid) {
  const s = getSession(psid);
  if (!s.profileName) await ensureProfileName(psid);

  s.pending = 'advisor_dept';
  s.vars.departamento = null;
  s.vars.zona = null;

  if (!hasGFData()) {
    console.error('[Greenfield] NO hay data válida en GF. Revisá /debug/config y /debug/files');

    const a = pickFallbackAdvisor();
    if (a?.whatsapp) {
      const msg = buildDefaultWhatsAppMessage(s);
      const url = waLink(a.whatsapp, msg);
      await sendText(psid, 'Con gusto 😊\nTe dejo un contacto directo para que te atiendan por WhatsApp:');
      await sendButtons(psid, 'Abrir WhatsApp:', [{ type: 'web_url', url, title: 'Contactar por WhatsApp' }]);
      await showMainMenu(psid);
      return;
    }

    await sendText(psid, 'Por el momento no tengo la lista de asesores cargada. Por favor intenta más tarde.');
    await showMainMenu(psid);
    return;
  }

  const deps = getDepartments();
  await sendText(psid, 'Perfecto ✅\nPara mostrarte los asesores disponibles, elige tu *departamento*:');
  await sendQR(psid, 'Selecciona un departamento:', deps.map(d => ({
    title: d.name,
    payload: `GF_A_DEPT_${d.id}`,
  })));
}

async function showAdvisorZonesSCZ(psid) {
  const zones = getDeptZones('santa_cruz') || [];
  if (!zones.length) {
    await sendText(psid, 'No tengo zonas configuradas para Santa Cruz. Te muestro los asesores disponibles:');
    return showAdvisorCards(psid, findDeptById('santa_cruz')?.advisorIds || [], 'Asesores disponibles');
  }

  await sendText(psid, 'Gracias ✅\nAhora elige tu *zona* en Santa Cruz:');
  await sendQR(psid, 'Selecciona una zona:', zones.map(z => ({
    title: z.name,
    payload: `GF_A_SCZ_ZONE_${z.id}`,
  })));
}

async function showAdvisorCards(psid, advisorIds = [], headerText = 'Selecciona tu asesor') {
  const s = getSession(psid);

  const unique = [...new Set((advisorIds || []).filter(Boolean))].slice(0, 10);
  if (!unique.length) {
    await sendText(psid, 'No encontré asesores para esa selección. Intenta con otra opción 👇');
    await startAdvisorFlow(psid);
    return;
  }

  const msg = buildDefaultWhatsAppMessage(s);

  const elements = [];
  for (const id of unique) {
    const a = getAdvisorById(id);
    if (!a?.whatsapp) continue;

    const img = resolveImageUrl(a.image);
    const url = waLink(a.whatsapp, msg);
    elements.push({
      title: String(a.name || 'Asesor').slice(0, 80),
      image_url: img || undefined,
      buttons: [{ type: 'web_url', url, title: String(a.name || 'Contactar').slice(0, 20) }], // botón con nombre
    });
  }

  if (!elements.length) {
    await sendText(psid, 'No encontré asesores con WhatsApp disponible en esta selección. Intenta con otra opción 👇');
    await startAdvisorFlow(psid);
    return;
  }

  await sendText(psid, `${headerText} 👇`);
  if (elements.length === 1) {
    const el = elements[0];
    const img = el.image_url;
    const btn = el.buttons?.[0];

    if (img && btn?.url) {
      try {
        await sendMediaCard(psid, img, btn.url, btn.title || 'Contactar por WhatsApp');
      } catch (e) {
        console.error('[Greenfield] media failed, fallback generic:', e?.message || e);
        await sendGenericCards(psid, elements);
      }
    } else {
      await sendGenericCards(psid, elements);
    }
  } else {
    await sendGenericCards(psid, elements);
  }

  await sendText(psid, 'Si necesitas algo más, puedes volver al menú 😊');
  await showMainMenu(psid);
}

const isGreeting = (t = '') => /\b(hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hello|hey|hi)\b/.test(norm(t));
const isEnd = (t = '') => /\b(chau|chao|adios|adiós|bye|finalizar|salir|eso es todo|nada mas|nada más)\b/.test(norm(t));

function detectIntent(text) {
  const t = norm(text);
  if (!t) return null;

  if (isGreeting(t)) return { type: 'GREET' };
  if (isEnd(t)) return { type: 'END' };

  if (/(productos|catalogo|catálogo|portafolio|lista de productos|que venden|que ofrecen)/.test(t)) return { type: 'PRODUCTS' };
  if (/(asesor|agronomo|agrónomo|ingeniero|hablar con|contacto|whatsapp|wsp|numero|tel(e|é)fono)/.test(t)) return { type: 'AGRO' };
  if (/(ayuda|help|no entiendo|explica|como hago|cómo hago)/.test(t)) return { type: 'HELP' };

  if (/(precio|presio|cotizar|proforma|pedido|comprar|venta|cuanto cuesta|cuanto vale|stock|disponible|disponibilidad|agotado|ficha|etiqueta|msds|hoja de seguridad|dosis|toxicidad|plaga|maleza|hongo|roya|oruga|trips|pulgon|pulgón|gusano|enfermedad)/.test(t)) {
    return { type: 'AGRO' };
  }

  return null;
}

// Keywords fallback
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
  const replyText = kwItem?.reply?.text ? String(kwItem.reply.text) : null;
  const actionType = kwItem?.action?.type || 'NONE';

  if (replyText) await sendText(psid, replyText);

  if (actionType === 'SHOW_MAIN_MENU') { await showMainMenu(psid); return true; }
  if (actionType === 'END_SESSION') { await sendText(psid, '¡Gracias por escribirnos! 👋'); clearSession(psid); return true; }
  if (actionType === 'OPEN_AGRONOMO') { await startAdvisorFlow(psid); return true; }

  return false;
}

// Saludo
async function greetAndMenu(psid) {
  const s = getSession(psid);
  s.flags.greeted = true;
  s.flags.justOpenedAt = Date.now();
  await ensureProfileName(psid);

  await sendText(
    psid,
    `👋 ¡Hola${s.profileName ? ` ${s.profileName}` : ''}! Bienvenido a *Greenfield*.\n` +
    `Puedo ayudarte a ver nuestros productos y también a contactar a un asesor por WhatsApp.`
  );

  await showMainMenu(psid);
}

// WEBHOOK verify
router.get('/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// WEBHOOK main
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

        // PAYLOADS GF_
        if (typeof incoming === 'string' && incoming.startsWith('GF_')) {
          if (incoming === 'GF_HELP') { await showHelp(psid); continue; }

          if (incoming === 'GF_PRODUCTS') {
            const url = GF?.brand?.products_url || 'https://greenfield.com.bo/productos/';
            await sendText(psid, 'Con gusto 😊\nAquí puedes ver nuestro catálogo y conocer las opciones disponibles:');
            await sendButtons(psid, 'Abrir catálogo:', [{ type: 'web_url', url, title: 'Ver productos' }]);
            await showMainMenu(psid);
            continue;
          }

          if (incoming === 'GF_AGRO') { await startAdvisorFlow(psid); continue; }

          if (incoming.startsWith('GF_HELP_')) { await startAdvisorFlow(psid); continue; }

          if (incoming.startsWith('GF_A_DEPT_')) {
            const id = incoming.replace('GF_A_DEPT_', '');
            const dept = findDeptById(id);
            if (!dept) { await startAdvisorFlow(psid); continue; }

            s.vars.departamento = dept.name;
            s.vars.zona = null;

            if (dept.id === 'santa_cruz') { await showAdvisorZonesSCZ(psid); continue; }

            await showAdvisorCards(psid, dept.advisorIds || [], `Asesores en ${dept.name}`);
            continue;
          }

          if (incoming.startsWith('GF_A_SCZ_ZONE_')) {
            const zoneId = incoming.replace('GF_A_SCZ_ZONE_', '');
            const zone = findZoneById('santa_cruz', zoneId);
            if (!zone) { await showAdvisorZonesSCZ(psid); continue; }

            s.vars.departamento = 'Santa Cruz';
            s.vars.zona = zone.name;

            await showAdvisorCards(psid, zone.advisorIds || [], `Asesores — ${zone.name}`);
            continue;
          }
        }

        // Router por texto
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
          await sendText(psid, 'Con gusto 😊\nAquí puedes ver nuestro catálogo y conocer las opciones disponibles:');
          await sendButtons(psid, 'Abrir catálogo:', [{ type: 'web_url', url, title: 'Ver productos' }]);
          await showMainMenu(psid);
          continue;
        }

        if (intent?.type === 'HELP') { await showHelp(psid); continue; }
        if (intent?.type === 'AGRO') { await startAdvisorFlow(psid); continue; }

        const kwHit = detectKeywordHit(textMsg);
        if (kwHit) {
          const handled = await runKeywordAction(psid, kwHit);
          if (handled) continue;
        }

        if (!s.flags.greeted) { await greetAndMenu(psid); continue; }

        await sendText(psid, 'Para ayudarte más rápido, usa el menú 👇');
        await showMainMenu(psid);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('❌ /webhook messenger', e?.stack || e);
    res.sendStatus(500);
  }
});

export default router;
