//quote-engine.js
import fs from 'fs';
import path from 'path';
import { readPrices, readPricesPersonal } from './sheets.js';

const CATALOG = readJSON('./knowledge/catalog.json');

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
  } catch {
    return [];
  }
}

function canonSku(s = '') {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/LTS?|LT|LITROS?/g, 'L')
    .replace(/KGS?|KILOS?/g, 'KG');
}

function normName(s = '') {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase();
}

function parsePackFromText(t = '') {
  const m = String(t || '').match(
    /(\d+(?:[.,]\d+)?)\s*(L|LT|LTS|LITROS?|KG|KGS?|KILOS?)/i
  );
  if (!m) return null;
  const size = parseFloat(m[1].replace(',', '.'));
  const unit = /KG|KGS?|KILOS?/i.test(m[2]) ? 'KG' : 'L';
  if (!Number.isFinite(size) || size <= 0) return null;
  return { size, unit };
}

function splitSku(s = '') {
  const raw = String(s || '').trim();
  const i = raw.lastIndexOf('-');
  if (i < 0) return { base: raw, pack: null, canon: canonSku(raw) };
  const base = raw.slice(0, i);
  const tail = raw.slice(i + 1);
  const pack =
    parsePackFromText(tail) ||
    parsePackFromText('-' + tail) ||
    parsePackFromText(tail.replace(/-/g, ' '));
  return { base, pack, canon: canonSku(raw) };
}

function buildPriceIndex(list = []) {
  const bySku = new Map();
  const byCanon = new Map();
  const byBasePack = new Map();
  const keyBP = (base, unit, size) =>
    `${normName(base)}|${unit}|${size}`;

  for (const r of list || []) {
    const sku = String(r.sku || '').trim();
    if (!sku) continue;
    const cs = canonSku(sku);
    bySku.set(sku, r);
    byCanon.set(cs, r);

    const { base, pack } = splitSku(sku);
    if (base && pack) {
      byBasePack.set(keyBP(base, pack.unit, pack.size), r);
    }
  }

  return { list, bySku, byCanon, byBasePack };
}

function normalizeUnit(u = '') {
  const t = String(u).toLowerCase();
  if (/^kg|kilo/.test(t)) return 'KG';
  if (/^l|lt|litro/.test(t)) return 'L';
  if (/^unid|und|unidad/.test(t)) return 'UNID';
  return (t || '').toUpperCase() || '';
}

function parseQtyUnit(qtyText = '') {
  const t = String(qtyText || '').toLowerCase();
  const m = t.match(/([\d.,]+)/);
  const q = m ? parseFloat(m[1].replace(',', '.')) : 0;
  let u = 'UNID';
  if (/kg|kilo/.test(t)) u = 'KG';
  else if (/\b(l|lt|litro)s?\b/.test(t)) u = 'L';
  else if (/uni|und/.test(t)) u = 'UNID';
  return { qty: Number.isFinite(q) ? q : 0, unit: u };
}

function findCatalogBySKUorName(sku, name) {
  const s = String(sku || '');
  let prod = CATALOG.find(p => String(p.sku) === s);
  if (!prod && name) {
    const n = String(name)
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    prod = CATALOG.find(p =>
      String(p.nombre || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '') === n
    );
  }
  return prod || {};
}

const asMoney = n =>
  Math.round((Number(n) || 0) * 100) / 100;

function resolvePriceUSD(idx, { sku, nombre, presentacion }, rate) {
  let row = idx.bySku.get(String(sku || '').trim());
  if (!row) {
    row = idx.byCanon.get(canonSku(sku || ''));
  }
  if (!row && nombre && presentacion) {
    const candidate = `${String(nombre).trim()}-${String(
      presentacion
    ).trim()}`;
    row = idx.byCanon.get(canonSku(candidate));
  }
  if (!row) {
    const nm =
      String(nombre || '').trim() || splitSku(String(sku || '')).base;
    const pack =
      parsePackFromText(String(presentacion || '')) ||
      splitSku(String(sku || '')).pack;
    if (nm && pack) {
      row = idx.byBasePack.get(
        `${normName(nm)}|${pack.unit}|${pack.size}`
      );
    }
  }
  if (!row) return 0;
  let usd = Number(row?.precio_usd || 0);
  if (!usd && Number(row?.precio_bs || 0))
    usd = Number(row.precio_bs) / rate;
  return asMoney(usd || 0);
}

export async function buildQuoteFromSession(s, opts = {}) {
  const usePersonal = !!opts.usePersonal;
  const { prices: sheetList = [], rate } = usePersonal
    ? await readPricesPersonal()
    : await readPrices();

  const idx = buildPriceIndex(sheetList);
  const now = new Date();

  const nombre = s.profileName || 'Cliente';
  const dep = s?.vars?.departamento || 'ND';
  const zona = s?.vars?.subzona || 'ND';
  const cultivo = (s?.vars?.cultivos || [])[0] || 'ND';
  const ha = s?.vars?.hectareas || 'ND';
  const campana = s?.vars?.campana || 'ND';

  const itemsRaw =
    s?.vars?.cart && s.vars.cart.length
      ? s.vars.cart
      : s?.vars?.last_sku && s?.vars?.cantidad
      ? [
          {
            sku: s.vars.last_sku,
            nombre: s.vars.last_product,
            presentacion: s.vars.last_presentacion,
            cantidad: s.vars.cantidad,
          },
        ]
      : [];

  const items = [];

  for (const it of itemsRaw) {
    const sku = String(it?.sku || '').trim();
    const nombreP = it?.nombre || '';
    const pres = it?.presentacion || '';
    const qtyInf = parseQtyUnit(it?.cantidad || '');
    const prod = findCatalogBySKUorName(sku, nombreP);

    const unit = normalizeUnit(
      qtyInf.unit || prod?.unidad || ''
    );
    const pUSD = resolvePriceUSD(
      idx,
      {
        sku,
        nombre: (nombreP || prod?.nombre || '').trim(),
        presentacion: pres,
      },
      rate
    );

    const line = {
      sku,
      nombre: nombreP || prod?.nombre || sku || '-',
      ingrediente_activo:
        prod?.ingrediente_activo || prod?.formulacion || '',
      envase: pres
        || (Array.isArray(prod?.presentaciones)
          ? prod.presentaciones.join(', ')
          : ''),
      unidad: unit || 'UNID',
      cantidad: qtyInf.qty || 0,
      precio_usd: asMoney(pUSD),
      subtotal_usd: asMoney((qtyInf.qty || 0) * (pUSD || 0)),
    };

    items.push(line);
  }

  const subtotal = asMoney(
    items.reduce((a, b) => a + (b.subtotal_usd || 0), 0)
  );
  const total = subtotal;

  return {
    id: `COT-${Date.now()}`,
    fecha: now,
    rate,
    cliente: {
      nombre,
      departamento: dep,
      zona,
      cultivo,
      hectareas: ha,
      campana,
    },
    items,
    subtotal_usd: subtotal,
    total_usd: total,
    min_order_usd: 3000,
    moneda: 'USD',
    price_catalog: idx.list,
  };
}
