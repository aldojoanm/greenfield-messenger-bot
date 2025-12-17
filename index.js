// messenger/greenfield.js
import 'dotenv/config';
import express from 'express';
import fs from 'fs';

const router = express.Router();
router.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}
const CFG_PATH = process.env.GREENFIELD_ADVISORS_JSON || './knowledge/greenfield_advisors.json';
let GF = loadJSON(CFG_PATH);
const PRODUCTS_PATH = process.env.GREENFIELD_PRODUCTS_JSON || './knowledge/greenfield_products.json';
let PRODUCTS = loadJSON(PRODUCTS_PATH);
const KEYWORDS_PATH = process.env.GREENFIELD_KEYWORDS_JSON || './knowledge/keywords.json';
let KEYWORDS = loadJSON(KEYWORDS_PATH);

function reloadConfig() {
  const nextGF = loadJSON(CFG_PATH);
  if (nextGF) GF = nextGF;

  const nextP = loadJSON(PRODUCTS_PATH);
  if (nextP) PRODUCTS = nextP;

  const nextK = loadJSON(KEYWORDS_PATH);
  if (nextK) KEYWORDS = nextK;
}
setInterval(reloadConfig, 2 * 60 * 1000);
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
const SESSIONS_MAX = 800;
const sessions = new Map();

function newSession() {
  const now = Date.now();
  return {
    pending: null, 
    vars: {
      departamento: null,
      zona: null,
      motivo: null,     
      producto: null,  
      productoId: null, 
      cultivo: null,
      problema: null,
      advisorId: null
    },
    profileName: null,
    flags: {
      greeted: false,
      justOpenedAt: 0,
      helpShownAt: 0,
    },
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

const seenMIDs = [];
const seenSet = new Set();
function alreadyProcessed(mid) {
  if (!mid) return false;
  if (seenSet.has(mid)) return true;
  seenSet.add(mid);
  seenMIDs.push(mid);
  if (seenMIDs.length > 400) {
    const old = seenMIDs.shift();
    seenSet.delete(old);
  }
  return false;
}

const norm = (t = '') => String(t || '')
  .toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^\p{L}\p{N}\s\-\+]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const title = s => String(s || '').replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
const clamp = (t, n = 20) => (t.length <= n ? t : t.slice(0, n - 1) + '…');

function shouldPrompt(s, key, ttlMs = 8000) {
  if (s.lastPrompt && s.lastPrompt.key === key && Date.now() - s.lastPrompt.at < ttlMs) return false;
  s.lastPrompt = { key, at: Date.now() };
  return true;
}

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
  const quick_replies = (options || []).slice(0, 11).map(o => {
    if (typeof o === 'string') {
      return { content_type: 'text', title: clamp(o), payload: `QR_${o.replace(/\s+/g, '_').toUpperCase()}` };
    }
    return {
      content_type: 'text',
      title: clamp(o.title),
      payload: o.payload || `QR_${String(o.title || '').replace(/\s+/g, '_').toUpperCase()}`,
    };
  });

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
        payload: {
          template_type: 'generic',
          elements: (elements || []).slice(0, 10),
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
function getDepartments() {
  return (GF?.departments || []);
}
function getDeptNames() {
  return getDepartments().map(d => d.name);
}
function getAdvisorsMap() {
  return GF?.advisors || {};
}
function getAdvisorById(id) {
  const map = getAdvisorsMap();
  return map ? map[id] : null;
}
function getDeptZones(deptId) {
  const d = getDepartments().find(x => x.id === deptId);
  return d?.zones || [];
}
function findZoneById(deptId, zoneId) {
  return getDeptZones(deptId).find(z => z.id === zoneId) || null;
}
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
let PRODUCT_INDEX = null;

function buildProductsIndex() {
  const arr = Array.isArray(PRODUCTS) ? PRODUCTS : (PRODUCTS?.items || PRODUCTS?.products || null);
  const items = Array.isArray(arr) ? arr : [];
  const idx = items.map((p, i) => {
    const aliases = new Set();
    if (p?.nombre) aliases.add(norm(p.nombre));
    (p?.posibles_respuestas || []).forEach(x => aliases.add(norm(x)));
    const expanded = new Set();
    for (const a of aliases) {
      expanded.add(a);
      expanded.add(a.replace(/\-/g, ' '));
      expanded.add(a.replace(/\s+/g, ''));
    }
    return {
      i,
      raw: p,
      nombreN: norm(p?.nombre || ''),
      aliases: [...expanded].filter(Boolean),
      aliasTokens: [...expanded].map(a => a.split(' ').filter(Boolean)),
    };
  });
  PRODUCT_INDEX = idx;
}

function ensureProductsIndex() {
  if (!PRODUCT_INDEX) buildProductsIndex();
  return PRODUCT_INDEX || [];
}

function levenshtein(a, b) {
  a = String(a || '');
  b = String(b || '');
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = tmp;
    }
  }
  return dp[bl];
}

function tokenOverlapScore(qTokens, aTokens) {
  if (!qTokens.length || !aTokens.length) return 0;
  const qs = new Set(qTokens);
  let hit = 0;
  for (const t of aTokens) if (qs.has(t)) hit++;
  return hit / Math.max(1, Math.min(qTokens.length, aTokens.length));
}

function findBestProduct(text) {
  const t = norm(text);
  if (!t) return null;

  const idx = ensureProductsIndex();
  if (!idx.length) return null;
  for (const it of idx) {
    for (const a of it.aliases) {
      if (!a) continue;
      if (t.includes(a)) return { ...it, score: 1.0, why: 'includes' };
    }
  }
  const tokens = t.split(' ').filter(Boolean);
  if (!tokens.length) return null;

  const windows = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let len = 1; len <= 4; len++) {
      const slice = tokens.slice(i, i + len);
      if (!slice.length) continue;
      const s = slice.join(' ');
      if (s.length >= 3) windows.push({ s, tokens: slice });
    }
  }

  let best = null;

  for (const it of idx) {
    for (const alias of it.aliases) {
      if (!alias) continue;
      const aliasTokens = alias.split(' ').filter(Boolean);

      for (const w of windows) {
        const overlap = tokenOverlapScore(w.tokens, aliasTokens);
        let levScore = 0;
        const a = w.s.replace(/\s+/g, '');
        const b = alias.replace(/\s+/g, '');
        const maxLen = Math.max(a.length, b.length);
        if (maxLen <= 18) {
          const d = levenshtein(a, b);
          levScore = 1 - (d / Math.max(1, maxLen));
        }

        const score = Math.max(overlap * 0.9, levScore * 0.85);
        const good =
          (overlap >= 0.75 && w.s.length >= 4) ||
          (levScore >= 0.86 && maxLen <= 14) ||
          (levScore >= 0.90);

        if (!good) continue;

        if (!best || score > best.score) {
          best = { ...it, score, why: 'fuzzy', match: w.s, alias };
        }
      }
    }
  }

  if (best && best.score >= 0.82) return best;
  return null;
}

function formatProductInfo(p) {
  const nombre = p?.nombre || 'Producto';
  const cat = p?.categoria ? `*Categoría:* ${p.categoria}` : null;
  const pres = Array.isArray(p?.presentacion) && p.presentacion.length ? `*Presentación:* ${p.presentacion.join(', ')}` : null;
  const usos = p?.usos ? `*Usos:* ${p.usos}` : null;
  const alm = p?.almacenamiento ? `*Almacenamiento:* ${p.almacenamiento}` : null;

  const lines = [
    `🧪 *${nombre}*`,
    cat,
    pres,
    usos,
    alm
  ].filter(Boolean);

  return lines.join('\n');
}

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
      if (t.includes(pn)) candidates.push({ it, pn, len: pn.length });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0].it || null;
}

function waLink(phone, msg) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits.replace(/^\+/, '')}?text=${encodeURIComponent(msg)}`;
}

function renderWhatsAppMessage(s, motivoLabel = '') {
  const tpl = GF?.brand?.whatsapp_message_template
    || 'Hola, soy {{client_name}}. Te escribo desde {{departamento}} (zona: {{zona}}). Necesito ayuda con: {{motivo}}. {{extra}}';

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

// ====== UI / Menús ======
async function showMainMenu(psid) {
  await sendQR(psid, '¿En qué te puedo ayudar?', [
    { title: '🧪 Nuestros productos', payload: 'GF_PRODUCTS' },
    { title: '👨‍🌾 Hablar con un agrónomo', payload: 'GF_AGRO' },
    { title: '📌 Ayuda rápida', payload: 'GF_HELP' },
  ]);
}

async function showHelp(psid) {
  const s = getSession(psid);
  const COOLDOWN = 6000;
  if (Date.now() - (s.flags.helpShownAt || 0) < COOLDOWN) return;
  s.flags.helpShownAt = Date.now();

  await sendQR(psid, '📌 Ayuda rápida — elige una opción:', [
    { title: '💰 Precio / pedido', payload: 'GF_MOTIVO_PRECIO' },
    { title: '📄 Ficha técnica', payload: 'GF_MOTIVO_FICHA' },
    { title: '👨‍🌾 Hablar con agrónomo', payload: 'GF_AGRO' },
    { title: '🧪 Ver productos', payload: 'GF_PRODUCTS' },
  ]);
}

async function askDepartamento(psid) {
  const s = getSession(psid);
  s.pending = 'dept';
  if (!shouldPrompt(s, 'askDepartamento')) return;

  await sendQR(psid, 'Selecciona tu *departamento*:', getDepartments().map(d => ({
    title: d.name,
    payload: `GF_DEPT_${d.id}`
  })));
}

async function askSczZone(psid) {
  const s = getSession(psid);
  s.pending = 'scz_zone';
  if (!shouldPrompt(s, 'askSczZone')) return;

  const zones = getDeptZones('santa_cruz');
  await sendQR(psid, 'Selecciona tu *zona de Santa Cruz*:', zones.map(z => ({
    title: z.name,
    payload: `GF_SCZ_ZONE_${z.id}`
  })));
}

async function askMotivo(psid) {
  const s = getSession(psid);
  s.pending = 'motivo';
  if (!shouldPrompt(s, 'askMotivo')) return;

  const motivos = GF?.handoff?.motivos || [
    { id: 'precio_pedido', label: 'Precio / Pedido' },
    { id: 'ficha_tecnica', label: 'Ficha técnica / Etiqueta' },
    { id: 'consulta_tecnica', label: 'Consulta técnica' },
    { id: 'disponibilidad', label: 'Disponibilidad' },
  ];

  await sendQR(psid, '¿Qué necesitas exactamente?', motivos.map(m => ({
    title: m.label,
    payload: `GF_MOTIVO_${m.id}`
  })));
}

async function showAdvisorsFor(psid, advisorIds = []) {
  const s = getSession(psid);
  const elements = [];

  for (const id of (advisorIds || []).slice(0, 10)) {
    const a = getAdvisorById(id);
    if (!a) continue;

    const motivoLabel = (GF?.handoff?.motivos || []).find(x => x.id === s.vars.motivo)?.label || 'Consulta';
    const msg = renderWhatsAppMessage(s, motivoLabel);
    const url = waLink(a.whatsapp, msg);

    const subtitle = [
      a.role ? a.role : null,
      a.coverage_note ? a.coverage_note : null,
    ].filter(Boolean).join(' • ').slice(0, 80);

    elements.push({
      title: String(a.name || 'Asesor').slice(0, 80),
      subtitle: subtitle || 'Asesor Greenfield',
      image_url: a.image,
      buttons: [
        url ? { type: 'web_url', url, title: '📲 WhatsApp' } : null,
        { type: 'postback', payload: `GF_SET_ADVISOR_${a.id}`, title: '✅ Elegir' },
      ].filter(Boolean),
    });
  }

  if (!elements.length) {
    await sendText(psid, 'No encontré asesores para esa zona aún. Por favor intenta otra zona o escribe "asesor".');
    return showHelp(psid);
  }

  await sendText(psid, `Listo${s.profileName ? ` ${s.profileName}` : ''} 😊 Te dejo los agrónomos recomendados:`);
  await sendGenericCards(psid, elements);
  await sendQR(psid, '¿Deseas algo más?', [
    { title: '📌 Ayuda rápida', payload: 'GF_HELP' },
    { title: 'Finalizar', payload: 'GF_END' }
  ]);
}

async function startAgronomoFlow(psid) {
  const s = getSession(psid);

  if (!s.profileName) await ensureProfileName(psid);
  if (!s.vars.motivo) await askMotivo(psid);
  else await askDepartamento(psid);
}

async function continueAfterMotivo(psid) {
  const s = getSession(psid);
  if (!s.vars.departamento) return askDepartamento(psid);
  if (s.vars.departamento === 'Santa Cruz' && !s.vars.zona) return askSczZone(psid);

  const dept = getDepartments().find(d => d.name === s.vars.departamento);
  const ids = dept?.advisorIds || [];
  return showAdvisorsFor(psid, ids);
}

const isGreeting = (t = '') => {
  const s = norm(t).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  return /\b(hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hello|hey|hi)\b/.test(s);
};

const wantsHours    = t => /(horario|atienden|hora|abierto|cerrado)/i.test(norm(t));
const wantsLocation = t => /(ubicacion|direccion|mapa|donde quedan|donde estan)/i.test(norm(t));
const isJunk        = t => /^[\.\?\!]+$/.test(String(t || '').trim());

async function runKeywordAction(psid, kwItem, rawText) {
  const s = getSession(psid);

  const replyText = kwItem?.reply?.text ? String(kwItem.reply.text) : null;
  const actionType = kwItem?.action?.type || 'NONE';

  if (replyText) await sendText(psid, replyText);

  if (actionType === 'SHOW_MAIN_MENU') return showMainMenu(psid);

  if (actionType === 'OPEN_AGRONOMO') {
    s.vars.motivo = s.vars.motivo || null;
    return startAgronomoFlow(psid);
  }

  if (actionType === 'ASK_PRODUCT_THEN_AGRONOMO') {
    s.pending = 'ask_product';
    if (!s.vars.motivo) s.vars.motivo = 'ficha_tecnica';
    await sendText(psid, 'Decime el *nombre del producto* (aunque esté medio mal escrito) y te ayudo 👇');
    return askDepartamento(psid);
  }

  if (actionType === 'ASK_CULTIVO_PROBLEMA_THEN_AGRONOMO') {
    if (!s.vars.motivo) s.vars.motivo = 'consulta_tecnica';
    s.pending = 'ask_cultivo';
    await sendText(psid, '1) ¿Qué *cultivo* manejas? (ej: soya/maíz/caña)');
    return;
  }

  if (actionType === 'ASK_MOTIVO_AND_ZONE') {
    s.pending = 'motivo';
    await askMotivo(psid);
    return;
  }

  if (actionType === 'ASK_MOTIVO_AND_OPEN_AGRONOMO') {
    s.pending = 'motivo';
    await askMotivo(psid);
    return;
  }

  return;
}

// ====== Webhook verify ======
router.get('/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

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
          s.flags.greeted = true;
          s.flags.justOpenedAt = Date.now();
          await ensureProfileName(psid);
          await sendText(psid, `👋 ¡Hola${s.profileName ? ` ${s.profileName}` : ''}! Soy el asistente de *Greenfield*.`);
          await sendText(psid, `Puedes tocar botones o escribirme directo (ej: "precio balancer" / "ficha técnica balancer" / "¿para qué sirve urea?").`);
          await showMainMenu(psid);
          continue;
        }
        let text = textMsg;
        if (qrPayload) text = qrPayload;
        if (typeof text === 'string' && text.startsWith('GF_')) {
          if (text === 'GF_END') {
            await sendText(psid, '¡Gracias por escribirnos! Si necesitas algo más, aquí estaré. 👋');
            clearSession(psid);
            continue;
          }

          if (text === 'GF_HELP') { await showHelp(psid); continue; }

          if (text === 'GF_PRODUCTS') {
            const url = GF?.brand?.products_url || 'https://greenfield.com.bo/productos/';
            await sendButtons(psid, '🧪 Nuestros productos 👇', [{ type: 'web_url', url, title: 'Ver productos' }]);
            await sendText(psid, 'Si me dices el *producto* y tu *zona*, te conecto con el agrónomo (precio/pedido o ficha técnica).');
            await showHelp(psid);
            continue;
          }

          if (text === 'GF_AGRO') {
            await startAgronomoFlow(psid);
            continue;
          }

          if (text === 'GF_MOTIVO_PRECIO') {
            s.vars.motivo = 'precio_pedido';
            await sendText(psid, 'Perfecto. Para *precio/pedido* te asigno un agrónomo por zona.');
            await askDepartamento(psid);
            continue;
          }

          if (text === 'GF_MOTIVO_FICHA') {
            s.vars.motivo = 'ficha_tecnica';
            s.pending = 'ask_product';
            await sendText(psid, 'Perfecto. Para *ficha técnica/etiqueta* te asigno un agrónomo por zona.');
            await sendText(psid, '¿Qué producto necesitas? (ej: Balancer)');
            await askDepartamento(psid);
            continue;
          }

          if (text.startsWith('GF_MOTIVO_')) {
            const id = text.replace('GF_MOTIVO_', '');
            s.vars.motivo = id;
            await continueAfterMotivo(psid);
            continue;
          }

          if (text.startsWith('GF_DEPT_')) {
            const id = text.replace('GF_DEPT_', '');
            const dept = getDepartments().find(d => d.id === id);
            if (!dept) { await askDepartamento(psid); continue; }
            s.vars.departamento = dept.name;
            s.vars.zona = null;
            s.pending = null;

            if (dept.id === 'santa_cruz') {
              await askSczZone(psid);
            } else {
              await showAdvisorsFor(psid, dept.advisorIds || []);
            }
            continue;
          }

          if (text.startsWith('GF_SCZ_ZONE_')) {
            const zoneId = text.replace('GF_SCZ_ZONE_', '');
            const zone = findZoneById('santa_cruz', zoneId);
            if (!zone) { await askSczZone(psid); continue; }
            s.vars.departamento = 'Santa Cruz';
            s.vars.zona = zone.name;
            s.pending = null;

            await showAdvisorsFor(psid, zone.advisorIds || []);
            continue;
          }

          if (text.startsWith('GF_SET_ADVISOR_')) {
            const id = text.replace('GF_SET_ADVISOR_', '');
            const a = getAdvisorById(id);
            if (a) {
              s.vars.advisorId = id;
              await sendText(psid, `✅ Listo. Te asigné a *${a.name}*. Puedes escribirle por WhatsApp con el botón de la tarjeta.`);
              await showHelp(psid);
            } else {
              await sendText(psid, 'No pude identificar el asesor. Intenta nuevamente.');
            }
            continue;
          }
        }

        const t = textMsg || '';

        if (!s.flags.greeted && isGreeting(t)) {
          s.flags.greeted = true;
          s.flags.justOpenedAt = Date.now();
          await ensureProfileName(psid);
          await sendText(psid, `👋 ¡Hola${s.profileName ? ` ${s.profileName}` : ''}! Soy el asistente de *Greenfield*.`);
          await showMainMenu(psid);
          continue;
        }

        if (isJunk(t)) {
          await sendQR(psid, 'Te leo 🙂 ¿Qué necesitas?', [
            { title: '💰 Precio / pedido', payload: 'GF_MOTIVO_PRECIO' },
            { title: '📄 Ficha técnica', payload: 'GF_MOTIVO_FICHA' },
            { title: '👨‍🌾 Hablar con agrónomo', payload: 'GF_AGRO' },
          ]);
          continue;
        }
        const kwHit = detectKeywordHit(t);
        if (kwHit) {
          await runKeywordAction(psid, kwHit, t);
          const prodFromText = findBestProduct(t);
          if (prodFromText?.raw) {
            s.vars.producto = prodFromText.raw.nombre || s.vars.producto;
            s.vars.productoId = String(prodFromText.i);
          }
          continue;
        }

        if (s.pending === 'ask_cultivo') {
          const cultivo = String(t || '').trim();
          if (cultivo && cultivo.length >= 2) {
            s.vars.cultivo = title(cultivo).slice(0, 40);
            s.pending = 'ask_problema';
            await sendText(psid, '2) ¿Qué *problema* tienes? (plaga/maleza/hongo/síntoma)');
            continue;
          }
        }

        if (s.pending === 'ask_problema') {
          const prob = String(t || '').trim();
          if (prob && prob.length >= 2) {
            s.vars.problema = prob.slice(0, 120);
            s.pending = null;
            await sendText(psid, 'Perfecto ✅ Con esos datos te conecto con un agrónomo por zona.');
            await askDepartamento(psid);
            continue;
          }
        }

        if (s.pending === 'ask_product') {
          const guess = findBestProduct(t);
          if (guess?.raw) {
            const p = guess.raw;
            s.vars.producto = p.nombre ? String(p.nombre).slice(0, 60) : title(t).slice(0, 60);
            s.vars.productoId = String(guess.i);
            s.pending = null;
            await sendText(psid, `✅ Entendido. ¿Te refieres a *${s.vars.producto}*?`);
            await sendText(psid, formatProductInfo(p));
            if (s.vars.motivo === 'ficha_tecnica' || s.vars.motivo === 'precio_pedido' || s.vars.motivo === 'disponibilidad' || s.vars.motivo === 'consulta_tecnica') {
              await continueAfterMotivo(psid);
            } else {
              await showHelp(psid);
            }
            continue;
          } else {
            const prod = String(t || '').trim();
            if (prod && prod.length >= 2) {
              s.vars.producto = title(prod).slice(0, 60);
              s.vars.productoId = null;
              s.pending = null;
              await sendText(psid, `Perfecto. Producto: *${s.vars.producto}* ✅`);
              await continueAfterMotivo(psid);
              continue;
            }
          }
        }
        const prodHit = findBestProduct(t);
        if (prodHit?.raw) {
          const p = prodHit.raw;
          s.vars.producto = p.nombre ? String(p.nombre).slice(0, 60) : s.vars.producto;
          s.vars.productoId = String(prodHit.i);
          const tn = norm(t);
          const isProdQuestion =
            /(para que sirve|sirve|uso|usos|presentacion|presentaciones|como se usa|dosis|almacenamiento|guardar|conservar|ficha|etiqueta|msds|hoja de seguridad)/.test(tn);

          if (isProdQuestion) {
            await sendText(psid, formatProductInfo(p));
            if (/(precio|presio|costo|cuanto cuesta|cuanto vale|cotizar|proforma|pedido|comprar|venta)/.test(tn)) {
              s.vars.motivo = 'precio_pedido';
              await sendText(psid, '👨‍🌾 Para precios/pedidos te asigno un agrónomo por zona.');
              await askDepartamento(psid);
              continue;
            }
            if (/(ficha|etiqueta|msds|hoja de seguridad)/.test(tn)) {
              s.vars.motivo = 'ficha_tecnica';
              await sendText(psid, '📄 Para enviarte la ficha/etiqueta te asigno un agrónomo por zona.');
              await askDepartamento(psid);
              continue;
            }
            await showHelp(psid);
            continue;
          }
          await sendQR(psid, `¿Qué necesitas de *${p.nombre}*?`, [
            { title: '📌 Usos/almacenamiento', payload: 'GF_PROD_INFO' },
            { title: '📄 Ficha técnica', payload: 'GF_MOTIVO_FICHA' },
            { title: '💰 Precio / pedido', payload: 'GF_MOTIVO_PRECIO' },
          ]);
          continue;
        }
        if (qrPayload === 'GF_PROD_INFO') {
          const idx = ensureProductsIndex();
          const p = (s.vars.productoId && idx[Number(s.vars.productoId)]) ? idx[Number(s.vars.productoId)].raw : null;
          if (p) {
            await sendText(psid, formatProductInfo(p));
            await showHelp(psid);
          } else {
            await sendText(psid, 'Decime el *nombre del producto* y te digo usos/presentación/almacenamiento.');
            s.pending = 'ask_product';
          }
          continue;
        }
        if (wantsHours(t)) {
          await sendText(psid, GF?.brand?.hours_text || '🕒 Horarios: (coloca aquí el horario real de Greenfield).');
          await showHelp(psid);
          continue;
        }

        if (wantsLocation(t)) {
          await sendText(psid, GF?.brand?.location_text || '📍 Ubicación: (coloca aquí dirección/mapa).');
          await showHelp(psid);
          continue;
        }
        if (s.vars.departamento === 'Santa Cruz' && !s.vars.zona) {
          const z = detectSczZoneByKeywords(t);
          if (z) {
            s.vars.zona = z.name;
            await showAdvisorsFor(psid, z.advisorIds || []);
            continue;
          }
        }
        if (!s.flags.greeted) {
          s.flags.greeted = true;
          await ensureProfileName(psid);
          await sendText(psid, `👋 ¡Hola${s.profileName ? ` ${s.profileName}` : ''}! Soy el asistente de *Greenfield*.`);
        }
        await sendText(psid, 'Puedo ayudarte con *usos/presentación/almacenamiento* de productos, *ficha técnica*, *precio/pedido* y *contacto con un agrónomo*.');
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
