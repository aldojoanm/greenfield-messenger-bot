// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

// Routers existentes (déjalos como ya los tienes)
import waRouter from './wa.js';
import messengerRouter from './index.js';
import pricesRouter from './prices.js';
import { readPricesPersonal } from './sheets.js';

// ========= Sheets (SIN carpeta /src) =========
import {
  summariesLastNDays,
  historyForIdLastNDays,
  appendMessage,
  readPrices,
  writePrices,
  readRate,
  writeRate,
} from './sheets.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TZ = process.env.TIMEZONE || 'America/La_Paz';

// Básicos
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

// Routers existentes
app.use(messengerRouter);
app.use(waRouter);
app.use(pricesRouter);

// ================== FB METRICS (Google Sheets) ==================
const FB_SHEET_ID = process.env.FB_METRICS_SHEET_ID;
let _fbSheets; // cache

async function getFbSheets() {
  if (!FB_SHEET_ID) throw new Error('Falta FB_METRICS_SHEET_ID en .env');
  if (_fbSheets) return _fbSheets;

  let auth;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;

  if (raw && raw.trim()) {
    const creds = JSON.parse(raw);
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    throw new Error(
      'Faltan credenciales Google (GOOGLE_CREDENTIALS_JSON o GOOGLE_APPLICATION_CREDENTIALS)'
    );
  }

  const client = await auth.getClient();
  _fbSheets = google.sheets({ version: 'v4', auth: client });
  return _fbSheets;
}

// ================== Parseos de Sheets ==================

// Parseo flexible de columnas para hojas de "mes" (Octubre, Noviembre, etc.)
function mapRowsByHeader(values) {
  const rows = values || [];
  if (!rows.length) return { data: [] };

  const header = rows[0].map((h) => String(h).trim());
  const idx = Object.fromEntries(header.map((h, i) => [h.toLowerCase(), i]));
  const get = (row, key) => {
    const i = idx[String(key).toLowerCase()];
    return i != null && i >= 0 ? row[i] : '';
  };
  const toNum = (v) => {
    const n = Number(String(v ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  const data = rows
    .slice(1)
    .filter((r) => r && r.length)
    .filter((r) => {
      const f = String(
        get(r, 'Fecha') || get(r, 'fecha') || ''
      ).trim();
      return f && !/^TOTALES/i.test(f);
    })
    .map((r) => ({
      Fecha: String(
        get(r, 'Fecha') || get(r, 'fecha') || ''
      ).slice(0, 10),
      Interacciones: toNum(get(r, 'Interacciones con el contenido')),
      Visualizaciones: toNum(get(r, 'Visualizaciones')),
      Espectadores: toNum(get(r, 'Espectadores')),
      Visitas: toNum(get(r, 'Visitas de Facebook')),
      Clics: toNum(
        get(r, 'Click en el enlace') || get(r, 'Clics en el enlace')
      ),
      Seguidores: toNum(
        get(r, 'Seguidores Nuevos') || get(r, 'Seguidores de Facebook')
      ),
    }));

  return { data };
}

// *** NUEVO ***
// Parseo genérico para hoja "Demografia" (no filtramos por Fecha, mapeamos todo tal cual encabezados)
function mapDemografiaRowsByHeader(values) {
  const rows = values || [];
  if (!rows.length) return { data: [] };

  const [header, ...dataRows] = rows;

  const data = dataRows
    // quitamos filas 100% vacías
    .filter((r) =>
      r && r.some((cell) => String(cell ?? '').trim() !== '')
    )
    .map((row) => {
      const obj = {};
      header.forEach((h, i) => {
        const key = String(h || '').trim();
        if (!key) return;
        obj[key] = row[i] ?? '';
      });
      return obj;
    });

  return { data };
}

// Lista de hojas (meses + Demografia)
app.get('/api/fbmetrics/sheets', async (_req, res) => {
  try {
    const sheets = await getFbSheets();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: FB_SHEET_ID,
      fields: 'sheets(properties(title,index))',
    });
    const list = (meta.data.sheets || [])
      .map((s) => s.properties?.title)
      .filter(Boolean);
    res.json({ sheets: list });
  } catch (e) {
    console.error('[fbmetrics/sheets]', e?.message || e);
    res.status(500).json({ error: 'No se pudo listar hojas' });
  }
});

// Datos de una hoja (mes o Demografia)
app.get('/api/fbmetrics/data', async (req, res) => {
  const sheet = String(req.query.sheet || '').trim();
  if (!sheet) return res.status(400).json({ error: 'Falta ?sheet=' });

  try {
    const sheets = await getFbSheets();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: FB_SHEET_ID,
      range: `${sheet}!A1:Z10000`,
    });

    const values = r.data.values || [];

    // Si no hay nada, devolvemos vacío tal cual
    if (!values.length) {
      return res.json({ sheet, rows: [] });
    }

    // Miramos SOLO el encabezado para decidir cómo parsear
    const headerRow = values[0] || [];
    const hasFechaHeader = headerRow.some((h) =>
      String(h || '').toLowerCase().includes('fecha')
    );

    let data;
    if (hasFechaHeader) {
      // Hojas de métricas mensuales (Octubre, Noviembre, etc.)
      ({ data } = mapRowsByHeader(values));
    } else {
      // Hojas sin "Fecha" en el encabezado → Demografia (u otras tablas similares)
      ({ data } = mapDemografiaRowsByHeader(values));
    }

    res.json({ sheet, rows: data });
  } catch (e) {
    console.error('[fbmetrics/data]', e?.message || e);
    res
      .status(500)
      .json({ error: 'No se pudo leer datos de la hoja solicitada' });
  }
});

// ================== FIN FB METRICS ==================

// ======= Catálogo (existente) =======
app.get('/api/catalog', async (_req, res) => {
  try {
    const { prices = [], rate = 6.96 } = await readPrices();

    const byProduct = new Map();
    for (const p of prices) {
      const sku = String(p.sku || '').trim();
      let producto = sku,
        presentacion = '';
      if (sku.includes('-')) {
        const parts = sku.split('-');
        producto = (parts.shift() || '').trim();
        presentacion = parts.join('-').trim();
      }
      if (!producto) continue;

      const usd = Number(p.precio_usd || 0);
      const bs =
        Number(p.precio_bs || 0) ||
        (usd ? +(usd * rate).toFixed(2) : 0);
      const unidad = String(p.unidad || '').trim();
      const categoria =
        String(p.categoria || '').trim() || 'Herbicidas';

      const cur = byProduct.get(producto) || {
        nombre: producto,
        categoria,
        imagen: `/image/${producto}.png`,
        variantes: [],
      };
      cur.categoria = cur.categoria || categoria;
      if (presentacion || unidad || usd || bs) {
        cur.variantes.push({
          presentacion: presentacion || '',
          unidad,
          precio_usd: usd,
          precio_bs: bs,
        });
      }
      byProduct.set(producto, cur);
    }

    const items = [...byProduct.values()].sort((a, b) =>
      a.nombre.localeCompare(b.nombre, 'es')
    );

    res.json({
      ok: true,
      rate,
      items,
      count: items.length,
      source: 'sheet:PRECIOS',
    });
  } catch (e) {
    console.error('[catalog] from prices error]:', e);
    res
      .status(500)
      .json({ ok: false, error: 'catalog_unavailable' });
  }
});

// ========= AUTH simple para Inbox =========
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
function validateToken(token) {
  if (!AGENT_TOKEN) return true;
  return token && token === AGENT_TOKEN;
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.sendStatus(401);
  if (!validateToken(h.slice(7).trim()))
    return res.sendStatus(401);
  next();
}

// ========= SSE (EventSource) =========
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(
    data
  )}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {}
  }
}
app.get('/wa/agent/stream', (req, res) => {
  const token = String(req.query.token || '');
  if (!validateToken(token)) return res.sendStatus(401);

  res.setHeader(
    'Content-Type',
    'text/event-stream; charset=utf-8'
  );
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.write(': hi\n\n');

  const ping = setInterval(() => {
    try {
      res.write('event: ping\ndata: "💓"\n\n');
    } catch {}
  }, 25000);

  sseClients.add(res);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ========= Estado efímero para UI =========
const STATE = new Map(); // id -> { human:boolean, unread:number, last?:string, name?:string }

// ========= API del Inbox =========
app.post(
  '/wa/agent/import-whatsapp',
  auth,
  async (req, res) => {
    try {
      const days = Number(req.body?.days || 3650);
      const items = await summariesLastNDays(days);
      for (const it of items) {
        const st = STATE.get(it.id) || {
          human: false,
          unread: 0,
        };
        STATE.set(it.id, {
          ...st,
          name: it.name || it.id,
          last: it.last || '',
        });
      }
      res.json({ ok: true, imported: items.length });
    } catch (e) {
      console.error('[import-whatsapp]', e);
      res.status(500).json({
        error: 'no se pudo importar desde Sheets',
      });
    }
  }
);

app.get('/wa/agent/convos', auth, async (_req, res) => {
  try {
    const items = await summariesLastNDays(3650);
    const byId = new Map();
    for (const it of items) {
      byId.set(it.id, {
        id: it.id,
        name: it.name || it.id,
        last: it.last || '',
        lastTs: it.lastTs || 0,
        human: false,
        unread: 0,
      });
    }
    for (const [id, st] of STATE.entries()) {
      const cur =
        byId.get(id) || {
          id,
          name: id,
          last: '',
          lastTs: 0,
          human: false,
          unread: 0,
        };
      byId.set(id, {
        ...cur,
        name: st.name || cur.name || id,
        last: st.last || cur.last || '',
        human: !!st.human,
        unread: st.unread || 0,
      });
    }
    const convos = [...byId.values()]
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .map(({ lastTs, ...rest }) => rest);
    res.json({ convos });
  } catch (e) {
    console.error('[convos]', e);
    res
      .status(500)
      .json({ error: 'no se pudo leer Hoja 4' });
  }
});

app.get(
  '/wa/agent/history/:id',
  auth,
  async (req, res) => {
    const id = String(req.params.id || '');
    try {
      const rows = await historyForIdLastNDays(id, 3650);
      const memory = rows.map((r) => ({
        role: r.role,
        content: r.content,
        ts: r.ts,
      }));
      const name =
        STATE.get(id)?.name ||
        rows[rows.length - 1]?.name ||
        id;
      const last =
        memory[memory.length - 1]?.content || '';
      const st =
        STATE.get(id) || { human: false, unread: 0 };
      STATE.set(id, { ...st, last, name, unread: 0 });
      res.json({ id, name, human: !!st.human, memory });
    } catch (e) {
      console.error('[history]', e);
      res.status(500).json({
        error: 'no se pudo leer historial',
      });
    }
  }
);

app.post('/wa/agent/send', auth, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text)
    return res
      .status(400)
      .json({ error: 'to y text requeridos' });
  const id = String(to);
  const ts = Date.now();
  const name = STATE.get(id)?.name || id;

  try {
    await appendMessage({
      waId: id,
      name,
      ts,
      role: 'agent',
      content: String(text),
    });
    const st =
      STATE.get(id) || { human: false, unread: 0 };
    STATE.set(id, {
      ...st,
      last: String(text),
      unread: 0,
    });
    sseBroadcast('msg', {
      id,
      role: 'agent',
      content: String(text),
      ts,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[send]', e);
    res.status(500).json({
      error: 'no se pudo guardar en Hoja 4',
    });
  }
});

app.post('/wa/agent/read', auth, (req, res) => {
  const id = String(req.body?.to || '');
  if (!id)
    return res
      .status(400)
      .json({ error: 'to requerido' });
  const st =
    STATE.get(id) || { human: false, unread: 0 };
  STATE.set(id, { ...st, unread: 0 });
  res.json({ ok: true });
});

app.post('/wa/agent/handoff', auth, (req, res) => {
  const id = String(req.body?.to || '');
  const mode = String(req.body?.mode || '');
  if (!id)
    return res
      .status(400)
      .json({ error: 'to requerido' });
  const st =
    STATE.get(id) || { human: false, unread: 0 };
  STATE.set(id, { ...st, human: mode === 'human' });
  res.json({ ok: true });
});

const upload = multer({ storage: multer.memoryStorage() });
app.post(
  '/wa/agent/send-media',
  auth,
  upload.array('files'),
  async (req, res) => {
    const { to, caption = '' } = req.body || {};
    if (!to)
      return res
        .status(400)
        .json({ error: 'to requerido' });

    const id = String(to);
    const baseTs = Date.now();
    const files = Array.isArray(req.files)
      ? req.files
      : [];
    if (!files.length)
      return res
        .status(400)
        .json({ error: 'files vacío' });

    try {
      let idx = 0;
      for (const f of files) {
        const sizeKB =
          Math.round(
            (Number(f.size || 0) / 1024) * 10
          ) / 10;
        const line = `📎 Archivo: ${f.originalname} (${sizeKB} KB)`;
        const ts = baseTs + idx++;
        await appendMessage({
          waId: id,
          name: STATE.get(id)?.name || id,
          ts,
          role: 'agent',
          content: line,
        });
        sseBroadcast('msg', {
          id,
          role: 'agent',
          content: line,
          ts,
        });
      }
      if (caption && caption.trim()) {
        const ts = baseTs + files.length;
        await appendMessage({
          waId: id,
          name: STATE.get(id)?.name || id,
          ts,
          role: 'agent',
          content: String(caption),
        });
        sseBroadcast('msg', {
          id,
          role: 'agent',
          content: String(caption),
          ts,
        });
        const st =
          STATE.get(id) || {
            human: false,
            unread: 0,
          };
        STATE.set(id, {
          ...st,
          last: String(caption),
          unread: 0,
        });
      }
      res.json({ ok: true, sent: files.length });
    } catch (e) {
      console.error('[send-media]', e);
      res.status(500).json({
        error: 'no se pudo guardar en Hoja 4',
      });
    }
  }
);

// ==== Campaña automática por mes (configurable por ENV) ====
const CAMP_VERANO_MONTHS = (process.env.CAMPANA_VERANO_MONTHS ||
  '10,11,12,1,2,3')
  .split(',')
  .map((n) => +n.trim())
  .filter(Boolean);
const CAMP_INVIERNO_MONTHS = (process.env.CAMPANA_INVIERNO_MONTHS ||
  '4,5,6,7,8,9')
  .split(',')
  .map((n) => +n.trim())
  .filter(Boolean);

function monthInTZ(tz = TZ) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      month: '2-digit',
    }).formatToParts(new Date());
    return +parts.find((p) => p.type === 'month').value;
  } catch {
    return new Date().getMonth() + 1;
  }
}
function currentCampana() {
  const m = monthInTZ(TZ);
  return CAMP_VERANO_MONTHS.includes(m)
    ? 'Verano'
    : 'Invierno';
}

app.get('/api/catalog-personal', async (_req, res) => {
  try {
    const { prices = [], rate = 6.96 } =
      await readPricesPersonal();

    const byName = new Map();
    for (const p of prices) {
      const key = p.nombre.trim();
      if (!byName.has(key)) {
        byName.set(key, {
          nombre: key,
          categoria: p.categoria || '',
          variantes: [],
        });
      }
      byName.get(key).variantes.push({
        presentacion: p.presentacion || '',
        unidad: p.unidad || '',
        precio_usd: p.precio_usd || 0,
        precio_bs: p.precio_bs || 0,
      });
    }

    const items = [...byName.values()];
    res.json({ items, rate });
  } catch (e) {
    console.error('catalog-personal error:', e);
    res.status(500).json({
      error: 'No se pudo cargar el catálogo personal',
    });
  }
});

/* ================== FB METRICS: exportar Excel server-side ================== */
/* Import dinámico: no rompe el arranque si el paquete faltara */
function rowsToAoA(rows) {
  const header = [
    'Fecha',
    'Interacciones',
    'Visualizaciones',
    'Espectadores',
    'Visitas',
    'Clics',
    'Seguidores',
  ];
  const body = (rows || []).map((r) => [
    String(r.Fecha || ''),
    +r.Interacciones || 0,
    +r.Visualizaciones || 0,
    +r.Espectadores || 0,
    +r.Visitas || 0,
    +r.Clics || 0,
    +r.Seguidores || 0,
  ]);
  return [header, ...body];
}
function aggTotalsExcel(rows) {
  const sum = (k) =>
    (rows || []).reduce(
      (a, b) => a + (+b[k] || 0),
      0
    );
  return [
    ['KPI', 'Valor'],
    ['Interacciones', sum('Interacciones')],
    ['Visualizaciones', sum('Visualizaciones')],
    ['Espectadores', sum('Espectadores')],
    ['Visitas', sum('Visitas')],
    ['Clics', sum('Clics')],
    ['Seguidores', sum('Seguidores')],
  ];
}

app.post('/api/fbmetrics/export', async (req, res) => {
  try {
    const mod = await import('xlsx'); // ← aquí el import
    const XLSX = mod.default || mod;

    const {
      rows = [],
      month = 'Mes',
      week = 'all',
    } = req.body || {};
    if (!Array.isArray(rows))
      return res
        .status(400)
        .send('rows debe ser un array');

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(
      rowsToAoA(rows)
    );
    const ws2 = XLSX.utils.aoa_to_sheet(
      aggTotalsExcel(rows)
    );
    XLSX.utils.book_append_sheet(wb, ws1, 'Datos');
    XLSX.utils.book_append_sheet(wb, ws2, 'Resumen');

    const buf = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    });
    const filename =
      week === 'all'
        ? `FB_Metricas_${month}.xlsx`
        : `FB_Metricas_${month}_Semana${week}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );
    return res.send(buf);
  } catch (e) {
    console.error('[fbmetrics/export] error:', e);
    return res
      .status(500)
      .send('error_generando_excel');
  }
});

// ==== Estáticos primero ====
app.use(
  '/image',
  express.static(path.join(__dirname, 'image'))
);
app.use(
  express.static(path.join(__dirname, 'public'))
);

// Aliases que también sirven estáticos (para que funcionen rutas relativas en cada HTML)
app.use(
  '/inbox-newchem',
  express.static(path.join(__dirname, 'public'))
);
app.use(
  '/catalogo-newchem',
  express.static(path.join(__dirname, 'public'))
);
app.use(
  '/catalogo_personal',
  express.static(path.join(__dirname, 'public'))
);
// OJO: este apunta a la subcarpeta correcta:
app.use(
  '/facebook-metricas',
  express.static(
    path.join(__dirname, 'public', 'metricas')
  )
);

// ==== Rutas "bonitas" que devuelven los HTML reales ====
app.get('/inbox-newchem', (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'agent.html')
  );
});
app.get('/catalogo-newchem', (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'catalog.html')
  );
});
app.get('/facebook-metricas', (_req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public',
      'metricas',
      'metricas.html'
    )
  );
});
app.get('/catalogo_personal', (_req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public',
      'catalogo_personal.html'
    )
  );
});
// ========= Arranque =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en :${PORT}`);
  console.log('   • Messenger:  GET/POST /webhook');
  console.log('   • WhatsApp:   GET/POST /wa/webhook');
  console.log('   • Inbox UI:   GET       /inbox');
  console.log(
    '   • FB Metrics: GET       /api/fbmetrics/sheets | /api/fbmetrics/data?sheet=Octubre'
  );
  console.log('   • Health:     GET       /healthz');
});
