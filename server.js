// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import waRouter from './whatsapp/wa.js';
import messengerRouter from './index.js';
import { readPrices, readPricesPersonal } from './sheets.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

app.use(messengerRouter);
app.use(waRouter);

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

function mapDemografiaRowsByHeader(values) {
  const rows = values || [];
  if (!rows.length) return { data: [] };

  const [header, ...dataRows] = rows;

  const data = dataRows
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

    if (!values.length) {
      return res.json({ sheet, rows: [] });
    }

    const headerRow = values[0] || [];
    const hasFechaHeader = headerRow.some((h) =>
      String(h || '').toLowerCase().includes('fecha')
    );

    let data;
    if (hasFechaHeader) {
      ({ data } = mapRowsByHeader(values));
    } else {
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
    console.error('[catalog] from prices error:', e);
    res
      .status(500)
      .json({ ok: false, error: 'catalog_unavailable' });
  }
});

app.get('/api/catalog-personal', async (_req, res) => {
  try {
    const { prices = [], rate = 6.96 } =
      await readPricesPersonal();

    const byName = new Map();
    for (const p of prices) {
      const key = (p.nombre || '').trim();
      if (!key) continue;

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
    const mod = await import('xlsx');
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

app.use(
  '/image',
  express.static(path.join(__dirname, 'image'))
);
app.use(
  express.static(path.join(__dirname, 'public'))
);

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
app.use(
  '/facebook-metricas',
  express.static(
    path.join(__dirname, 'public', 'metricas')
  )
);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en :${PORT}`);
  console.log('   • Messenger:       GET/POST /webhook');
  console.log('   • WhatsApp:        GET/POST /wa/webhook');
  console.log('   • Inbox UI:        GET       /inbox-newchem');
  console.log(
    '   • FB Metrics API:  GET       /api/fbmetrics/sheets | /api/fbmetrics/data?sheet=Octubre'
  );
  console.log('   • FB Métricas UI:  GET       /facebook-metricas');
  console.log('   • Health:          GET       /healthz');
});
