// ================== util ==================
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Intl.NumberFormat("es-BO").format(n || 0);
const fmtPct = (n) => `${(n || 0).toFixed(1)}%`;

// Colores de marca
const COLORS = {
  visual: "#618ED0",   // azul medio
  espec: "#57C3E1",    // celeste
  clics: "#877EBB",    // lila
  visitas: "#9ca3af",  // gris
  inter: "#22c55e",    // verde
  seg: "#f97316",      // naranja
};
const MONTH_NAMES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];


const METRIC_COLORS = {
  Visualizaciones: COLORS.visual,
  Espectadores: COLORS.espec,
  Interacciones: COLORS.inter,
  Visitas: COLORS.visitas,
  Clics: COLORS.clics,
  Seguidores: COLORS.seg,
};

const colorForMetric = (m) => METRIC_COLORS[m] || "#9ca3af";

// Evita renders ultra densos en HiDPI
if (window.Chart) {
  Chart.defaults.devicePixelRatio = Math.min(
    window.devicePixelRatio || 1,
    1.5
  );
}

// ======= Estado general =======
let allRows = [];        // mes completo
let currentRows = [];    // filtrado por semana
let weekBuckets = [];    // [{ini, fin, rows}]
let activeMetric = null; // métrica seleccionada

let chLine, chBar, chPieAll, chLineRel;
// Demografía
let chDeptosBo, chPais, chEdadGenero, chPages;
let demografiaSheetName = null;

let allYearRows = [];    // todas las filas del año seleccionado
let currentYear = null; 
let isYearView = false;

window.addEventListener("DOMContentLoaded", async () => {
  await cargarAnios();

  const selAnio = $("#anioSelect");
  const selMes = $("#mesSelect");
  const selSem = $("#semanaSelect");

  selAnio.addEventListener("change", async () => {
    await cargarAnio(selAnio.value);
  });

  selMes.addEventListener("change", () => cargarMes(selMes.value));
  selSem.addEventListener("change", () => aplicarSemana(selSem.value));
  $("#btnXlsx").addEventListener("click", handleDescargarExcel);

  // KPI click -> filtro por métrica (toggle)
  document.querySelectorAll(".kpi").forEach((k) => {
    k.addEventListener("click", () => {
      const m = k.dataset.metric;
      activeMetric = activeMetric === m ? null : m;
      document
        .querySelectorAll(".kpi")
        .forEach((x) =>
          x.classList.toggle("active", x.dataset.metric === activeMetric)
        );
      render(currentRows);
    });
  });
});

async function cargarAnios() {
  const r = await fetch("/api/fbmetrics/sheets");
  const j = await r.json();

  const selAnio = $("#anioSelect");
  const selMes = $("#mesSelect");
  selAnio.innerHTML = "";
  selMes.innerHTML = "";

  const years = [];

  (j.sheets || []).forEach((name) => {
    const lower = String(name).toLowerCase();

    // guardamos Demografia pero no la mostramos como año
    if (lower.includes("demografia")) {
      demografiaSheetName = name;
      return;
    }

    // solo hojas que sean exactamente 4 dígitos => años (2025, 2026, ...)
    if (/^\d{4}$/.test(name.trim())) {
      years.push(name.trim());
    }
  });

  years.sort(); // ascendente

  years.forEach((y) => {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    selAnio.appendChild(opt);
  });

  if (!years.length) return;

  // por defecto, último año con datos
  currentYear = years[years.length - 1];
  selAnio.value = currentYear;

  // carga datos de ese año + meses + último mes
  await cargarAnio(currentYear);

  // demografía (independiente del año)
  if (demografiaSheetName) {
    await cargarDemografia(demografiaSheetName);
  }
}

async function cargarAnio(yearSheetName) {
  if (!yearSheetName) return;

  currentYear = String(yearSheetName);

  const r = await fetch(
    `/api/fbmetrics/data?sheet=${encodeURIComponent(yearSheetName)}`
  );
  const j = await r.json();

  // Todas las filas del año
  allYearRows = (j.rows || []).slice();

  // Filtramos solo filas con fecha válida del año seleccionado
  allYearRows = allYearRows.filter((r) => {
    if (!r.Fecha) return false;
    const fechaStr = String(r.Fecha).slice(0, 10); // "YYYY-MM-DD"
    const [y] = fechaStr.split("-");
    return y === String(yearSheetName);
  });

  // Ordenar por fecha para mantener consistencia
  allYearRows.sort((a, b) => {
    const fa = String(a.Fecha);
    const fb = String(b.Fecha);
    return fa.localeCompare(fb);
  });

  // Construir meses disponibles en el año
  const meses = new Set();
  allYearRows.forEach((r) => {
    if (!r.Fecha) return;
    const fechaStr = String(r.Fecha).slice(0, 10);
    const parts = fechaStr.split("-");
    if (parts.length >= 2) {
      const m = parseInt(parts[1], 10);
      if (m >= 1 && m <= 12) meses.add(m);
    }
  });

  const selMes = $("#mesSelect");
  selMes.innerHTML = "";

  const ordenMeses = Array.from(meses).sort((a, b) => a - b);
  if (ordenMeses.length) {
    const optYear = document.createElement("option");
    optYear.value = "year";
    optYear.textContent = "Todo el año";
    selMes.appendChild(optYear);
  }

  // Opciones de meses normales
  ordenMeses.forEach((m) => {
    const mm = String(m).padStart(2, "0");
    const opt = document.createElement("option");
    opt.value = mm; // "01", "02", ...
    opt.textContent = `${mm} - ${MONTH_NAMES[m - 1]}`;
    selMes.appendChild(opt);
  });

  const selSem = $("#semanaSelect");
  selSem.innerHTML = '<option value="all">Todo el mes</option>';

  if (!ordenMeses.length) {
    // año sin datos
    allRows = [];
    currentRows = [];
    weekBuckets = [];
    render([]);
    return;
  }

  // 👉 Por defecto seguimos mostrando el último mes con datos
  const lastMonth = String(
    ordenMeses[ordenMeses.length - 1]
  ).padStart(2, "0");
  selMes.value = lastMonth;
  await cargarMes(lastMonth);

}

async function cargarMes(monthStr) {
  if (!allYearRows.length) return;

  const sel = $("#semanaSelect");

  // 👉 MODO ANUAL (Todo el año)
  if (monthStr === "year") {
    isYearView = true;

    // todas las filas del año seleccionado
    allRows = allYearRows.slice();

    // semanas del año completo (para el combo de semana, si quieres usarlo)
    weekBuckets = buildWeekBuckets(allRows);

    // primera opción = todo el año
    sel.innerHTML = '<option value="all">Todo el año</option>';

    weekBuckets.forEach((w, i) => {
      const opt = document.createElement("option");
      opt.value = String(i + 1);
      opt.textContent = `Semana ${i + 1} (${fmtDate(w.ini)} a ${fmtDate(
        w.fin
      )})`;
      sel.appendChild(opt);
    });

    sel.value = "all";
    aplicarSemana("all");
    return;
  }

  // 👉 MODO MENSUAL (como ya lo tenías)
  isYearView = false;

  if (!monthStr) return;

  const monthNum = parseInt(monthStr, 10);
  if (!(monthNum >= 1 && monthNum <= 12)) return;

  // Filtramos SOLO las filas que correspondan a ese año y mes
  allRows = allYearRows.filter((r) => {
    if (!r.Fecha) return false;
    const fechaStr = String(r.Fecha).slice(0, 10); // "YYYY-MM-DD"
    const parts = fechaStr.split("-");
    if (parts.length < 2) return false;

    const y = parts[0];
    const m = parseInt(parts[1], 10);

    return y === String(currentYear) && m === monthNum;
  });

  weekBuckets = buildWeekBuckets(allRows);

  sel.innerHTML = '<option value="all">Todo el mes</option>';
  weekBuckets.forEach((w, i) => {
    const opt = document.createElement("option");
    opt.value = String(i + 1);
    opt.textContent = `Semana ${i + 1} (${fmtDate(w.ini)} a ${fmtDate(
      w.fin
    )})`;
    sel.appendChild(opt);
  });
  sel.value = "all";
  aplicarSemana("all");
}

function aplicarSemana(val) {
  currentRows = val === "all" ? allRows : weekBuckets[+val - 1]?.rows || [];
  render(currentRows);
}

// ============ Semanas (L-D) ============
const toDate = (s) => new Date(s + "T00:00:00");
const mondayOf = (d) => {
  const day = (d.getDay() + 6) % 7;
  const m = new Date(d);
  m.setDate(d.getDate() - day);
  m.setHours(0, 0, 0, 0);
  return m;
};
const endSun = (d) => {
  const e = new Date(d);
  e.setDate(e.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
};
const fmtDate = (d) => d.toISOString().slice(0, 10);

function buildWeekBuckets(rows) {
  const map = new Map(); // mondayISO -> { rows:[] }

  for (const r of rows) {
    if (!r.Fecha) continue;
    const d = toDate(String(r.Fecha).slice(0, 10));
    const monday = mondayOf(d);
    const key = monday.toISOString().slice(0, 10);

    const cur = map.get(key) || { rows: [] };
    cur.rows.push(r);
    map.set(key, cur);
  }

  const buckets = [...map.values()].map((bucket) => {
    let minD = null;
    let maxD = null;

    for (const r of bucket.rows) {
      const d = toDate(String(r.Fecha).slice(0, 10));
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
    }

    return {
      ini: minD,
      fin: maxD,
      rows: bucket.rows,
    };
  });

  return buckets.sort((a, b) => a.ini - b.ini);
}


// ============ Totales ============
function aggTotals(rows) {
  const sum = (k) => rows.reduce((a, b) => a + (+b[k] || 0), 0);
  return {
    Interacciones: sum("Interacciones"),
    Visualizaciones: sum("Visualizaciones"),
    Espectadores: sum("Espectadores"),
    Visitas: sum("Visitas"),
    Clics: sum("Clics"),
    Seguidores: sum("Seguidores"),
  };
}

// ================== RENDER PRINCIPAL (meses) ==================
function render(rows) {
  const tot = aggTotals(rows);

  const alcance = tot.Visualizaciones;
  const audiencia = tot.Espectadores;
  const interacciones = tot.Interacciones;
  const visitas = tot.Visitas;
  const clics = tot.Clics;
  const seguidores = tot.Seguidores;

  const engagementRate =
    alcance > 0 ? (interacciones * 100.0) / alcance : 0.0;
  const ctr = alcance > 0 ? (clics * 100.0) / alcance : 0.0;
  const viewsPerUser = audiencia > 0 ? alcance / audiencia : 0.0;

  // KPIs
  $("#kpi-visual").textContent = fmt(alcance);
  $("#kpi-espec").textContent = fmt(audiencia);
  $("#kpi-inter").textContent = fmt(interacciones);
  $("#kpi-visitas").textContent = fmt(visitas);
  $("#kpi-clics").textContent = fmt(clics);
  $("#kpi-seg").textContent = fmt(seguidores);

  

  const engEl = $("#kpi-eng-rate");
  if (engEl) engEl.textContent = fmtPct(engagementRate);

  const ctrEl = $("#kpi-ctr");
  if (ctrEl) ctrEl.textContent = fmtPct(ctr);

  // Tabla
  const tbl = $("#tbl");
  const head = `
    <tr>
      <th>Fecha</th>
      <th>Interacciones</th>
      <th>Visualizaciones</th>
      <th>Espectadores</th>
      <th>Visitas</th>
      <th>Clics</th>
      <th>Seguidores</th>
    </tr>`;
  const body = rows
    .map(
      (r) => `
    <tr>
      <td>${r.Fecha}</td>
      <td>${fmt(r.Interacciones)}</td>
      <td>${fmt(r.Visualizaciones)}</td>
      <td>${fmt(r.Espectadores)}</td>
      <td>${fmt(r.Visitas)}</td>
      <td>${fmt(r.Clics)}</td>
      <td>${fmt(r.Seguidores)}</td>
    </tr>`
    )
    .join("");
  tbl.innerHTML = head + body;

  // Charts
  drawLine(rows);
  drawBars(rows);
  drawPie(tot);
}

function destroyChart(c) {
  if (c && typeof c.destroy === "function") c.destroy();
}

// ============ Agregación MENSUAL para vista anual ============

function aggregateByMonth(rows) {
  const byMonth = {};

  for (const r of rows) {
    if (!r.Fecha) continue;
    const fechaStr = String(r.Fecha).slice(0, 10); // "YYYY-MM-DD"
    const parts = fechaStr.split("-");
    if (parts.length < 2) continue;

    const m = parseInt(parts[1], 10);
    if (!(m >= 1 && m <= 12)) continue;

    if (!byMonth[m]) {
      byMonth[m] = {
        month: m,
        label: `${String(m).padStart(2, "0")} - ${MONTH_NAMES[m - 1]}`,
        Interacciones: 0,
        Visualizaciones: 0,
        Espectadores: 0,
        Visitas: 0,
        Clics: 0,
        Seguidores: 0,
      };
    }

    byMonth[m].Interacciones += +r.Interacciones || 0;
    byMonth[m].Visualizaciones += +r.Visualizaciones || 0;
    byMonth[m].Espectadores += +r.Espectadores || 0;
    byMonth[m].Visitas += +r.Visitas || 0;
    byMonth[m].Clics += +r.Clics || 0;
    byMonth[m].Seguidores += +r.Seguidores || 0;
  }

  return Object.values(byMonth).sort((a, b) => a.month - b.month);
}

// --------- Línea diaria ----------
// --------- Línea: diaria (mes) o mensual (año) ----------
function drawLine(rows) {
  destroyChart(chLine);
  const ctx = $("#chLine");
  if (!ctx) return;

  // Si estamos en vista de año, agregamos por MES
  const baseRows = isYearView ? aggregateByMonth(rows) : rows;

  const labels = isYearView
    ? baseRows.map((r) => r.label)
    : baseRows.map((r) => r.Fecha);

  const datasets = [];
  const want = (m) => !activeMetric || activeMetric === m;

  const add = (label, key, color, opts = {}) => {
    datasets.push({
      label,
      data: baseRows.map((r) => +r[key] || 0),
      tension: 0.35,
      borderColor: color,
      backgroundColor: color,
      pointRadius: 0,
      pointHitRadius: 8,
      pointHoverRadius: 4,
      borderWidth: opts.borderWidth ?? 2,
      yAxisID: "y", // un solo eje
    });
  };

  if (want("Visualizaciones"))
    add("Visualizaciones", "Visualizaciones", COLORS.visual);
  if (want("Espectadores"))
    add("Espectadores", "Espectadores", COLORS.espec);
  if (want("Clics")) add("Clics", "Clics", COLORS.clics);
  if (want("Visitas")) add("Visitas", "Visitas", COLORS.visitas);
  if (want("Interacciones"))
    add("Interacciones", "Interacciones", COLORS.inter);
  if (want("Seguidores"))
    add("Seguidores", "Seguidores", COLORS.seg);

  chLine = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 600,
        easing: "easeOutQuart",
      },
      interaction: { mode: "index", intersect: false },
      layout: { padding: 4 },
      scales: {
        x: {
          ticks: {
            color: "#6b7280",
            maxRotation: isYearView ? 0 : 0,
            autoSkip: true,
            autoSkipPadding: 8,
          },
          grid: { color: "rgba(148,163,184,0.18)" },
        },
        y: {
          ticks: { color: "#6b7280" },
          grid: { color: "rgba(148,163,184,0.18)" },
          position: "left",
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#111827",
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 18,
            font: {
              size: 11,
            },
          },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            title: (items) => {
              if (!items.length) return "";
              // título distinto en anual vs mensual
              return isYearView
                ? items[0].label // "01 - Enero"
                : items[0].label; // fecha exacta
            },
          },
        },
      },
    },
  });
}


// --------- Barras por semana ----------
// --------- Barras: semanales (mes) o mensuales (año) ----------
function drawBars(rows) {
  destroyChart(chBar);
  const ctx = $("#chBar");
  if (!ctx) return;

  const want = (m) => !activeMetric || activeMetric === m;
  const datasets = [];

  let labels;
  let buckets;

  if (isYearView) {
    // 👉 vista anual: usamos los meses agregados
    const monthly = aggregateByMonth(rows);
    labels = monthly.map((r) => r.label); // "01 - Enero", etc.

    const pushDs = (label, key, color) => {
      datasets.push({
        label,
        data: monthly.map((r) => +r[key] || 0),
        backgroundColor: color,
        borderRadius: 8,
        maxBarThickness: 32,
      });
    };

    if (want("Visualizaciones"))
      pushDs("Visualizaciones", "Visualizaciones", COLORS.visual);
    if (want("Clics")) pushDs("Clics", "Clics", COLORS.clics);
    if (want("Visitas")) pushDs("Visitas", "Visitas", COLORS.visitas);
    if (want("Espectadores"))
      pushDs("Espectadores", "Espectadores", COLORS.espec);
    if (want("Interacciones"))
      pushDs("Interacciones", "Interacciones", COLORS.inter);
    if (want("Seguidores"))
      pushDs("Seguidores", "Seguidores", COLORS.seg);
  } else {
    // 👉 vista mensual: tal como ya lo tenías (semanas)
    buckets = buildWeekBuckets(rows);
    labels = buckets.map(
      (w) => `Sem ${fmtDate(w.ini)} a ${fmtDate(w.fin)}`
    );
    const sum = (list, key) =>
      list.reduce((a, b) => a + (+b[key] || 0), 0);

    const pushDs = (label, key, color) => {
      datasets.push({
        label,
        data: buckets.map((b) => sum(b.rows, key)),
        backgroundColor: color,
        borderRadius: 6,
        maxBarThickness: 32,
      });
    };

    if (want("Visualizaciones"))
      pushDs("Visualizaciones", "Visualizaciones", COLORS.visual);
    if (want("Clics")) pushDs("Clics", "Clics", COLORS.clics);
    if (want("Visitas")) pushDs("Visitas", "Visitas", COLORS.visitas);
    if (want("Espectadores"))
      pushDs("Espectadores", "Espectadores", COLORS.espec);
    if (want("Interacciones"))
      pushDs("Interacciones", "Interacciones", COLORS.inter);
    if (want("Seguidores"))
      pushDs("Seguidores", "Seguidores", COLORS.seg);
  }

  chBar = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 600,
        easing: "easeOutQuart",
      },
      layout: { padding: 4 },
      scales: {
        x: {
          ticks: {
            color: "#6b7280",
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 8,
          },
          grid: { display: false },
        },
        y: {
          ticks: { color: "#6b7280" },
          grid: { color: "rgba(148,163,184,0.18)" },
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#111827",
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 18,
            font: {
              size: 11,
            },
          },
        },
      },
    },
  });
}


// --------- Dona principal ----------
function drawPie(tot) {
  destroyChart(chPieAll);
  const ctx = $("#chPieAll");
  if (!ctx) return;

  const labelsAll = [
    "Visualizaciones",
    "Espectadores",
    "Interacciones",
    "Visitas",
    "Clics",
    "Seguidores",
  ];

  const dataAll = [
    tot.Visualizaciones,
    tot.Espectadores,
    tot.Interacciones,
    tot.Visitas,
    tot.Clics,
    tot.Seguidores,
  ];

  const totalAll = dataAll.reduce((a, b) => a + (b || 0), 0);

  let labels = labelsAll.slice();
  let data = dataAll.slice();
  let bgColors = labelsAll.map((m) => colorForMetric(m));
  const pieSubtitle = $("#pieSubtitle");

  if (activeMetric && totalAll > 0) {
    const valSel = tot[activeMetric] || 0;
    const otros = Math.max(0, totalAll - valSel);
    labels = [activeMetric, "Otros KPIs"];
    data = [valSel, otros];
    bgColors = [colorForMetric(activeMetric), "#e5e7eb"];

    if (pieSubtitle) {
      const share = (valSel * 100.0) / totalAll;
      pieSubtitle.textContent = `Participación de "${activeMetric}" en el período: ${fmtPct(
        share
      )}.`;
    }
  } else if (pieSubtitle) {
    pieSubtitle.textContent =
      "Participación de cada métrica en el período seleccionado.";
  }

  chPieAll = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data,
          borderWidth: 0,
          backgroundColor: bgColors,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      layout: { padding: 4 },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#111827",
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 18,
            font: {
              size: 11,
            },
          },
        },
        tooltip: { enabled: true },
      },
    },
  });
}

// --------- Línea diaria (un solo eje Y a la izquierda) ----------
function drawLine(rows) {
  destroyChart(chLine);
  const ctx = $("#chLine");
  if (!ctx) return;

  const labels = rows.map((r) => r.Fecha);
  const datasets = [];
  const want = (m) => !activeMetric || activeMetric === m;

  const add = (label, key, color, opts = {}) => {
    datasets.push({
      label,
      data: rows.map((r) => +r[key] || 0),
      tension: 0.35,
      borderColor: color,
      backgroundColor: color,
      pointRadius: 0,        // puntos de la línea (no se ven)
      pointHitRadius: 8,
      pointHoverRadius: 4,
      borderWidth: opts.borderWidth ?? 2,
      yAxisID: "y",          // SIEMPRE el mismo eje
    });
  };

  if (want("Visualizaciones"))
    add("Visualizaciones", "Visualizaciones", COLORS.visual);
  if (want("Espectadores"))
    add("Espectadores", "Espectadores", COLORS.espec);
  if (want("Clics")) add("Clics", "Clics", COLORS.clics);
  if (want("Visitas")) add("Visitas", "Visitas", COLORS.visitas);
  if (want("Interacciones"))
    add("Interacciones", "Interacciones", COLORS.inter);
  if (want("Seguidores"))
    add("Seguidores", "Seguidores", COLORS.seg);

  chLine = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 600,
        easing: "easeOutQuart",
      },
      interaction: { mode: "index", intersect: false },
      layout: { padding: 4 },
      scales: {
        x: {
          ticks: {
            color: "#6b7280",
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 8,
          },
          grid: { color: "rgba(148,163,184,0.18)" },
        },
        y: {
          ticks: { color: "#6b7280" },
          grid: { color: "rgba(148,163,184,0.18)" },
          position: "left",
        },
        // y2 eliminado
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#111827",
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,   // más chico
            boxHeight: 8,  // más chico
            padding: 18,   // más separación visual
            font: {
              size: 11,
            },
          },
        },
        tooltip: { mode: "index", intersect: false },
      },
    },
  });
}


async function cargarDemografia(sheetName) {
  try {
    const r = await fetch(
      `/api/fbmetrics/data?sheet=${encodeURIComponent(sheetName)}`
    );
    if (!r.ok) {
      console.error("Error cargando Demografia:", await r.text());
      return;
    }

    const j = await r.json();
    const rows = j.rows || [];
    if (!rows.length) {
      console.warn("Hoja Demografia vacía");
      return;
    }

    // --- Detectar nombres de columnas automáticamente ---
    const keys = Object.keys(rows[0]);
    const findKey = (fn) =>
      keys.find((k) => {
        try {
          return fn(k.toLowerCase());
        } catch {
          return false;
        }
      });

    // Departamentos
    const keyCiudad = findKey((k) => k.includes("ciudad"));
    const keyPctCiudad = findKey(
      (k) => k.includes("porcentaje") && k.includes("ciudad")
    );

    // Países
    const keyPais = findKey((k) => k.includes("pais") || k.includes("país"));
    const keyPctPais = findKey(
      (k) => k.includes("porcentaje") && (k.includes("pais") || k.includes("país"))
    );

    // Rango de edad / género
    const keyRango = findKey(
      (k) => k.includes("rango") || (k.includes("edad") && !k.includes("promedio"))
    );
    const keyHombre = findKey((k) => k.includes("hombre"));
    const keyMujer = findKey((k) => k.includes("mujer"));
    const keyTotalEdad = findKey((k) => k === "total" || k.includes("total"));

    // Páginas
    const keyPages = findKey(
      (k) => k.includes("paginas") || k.includes("páginas")
    );
    const keyPctPage = findKey(
      (k) => k.includes("porcentaje") && k.includes("pagina")
    );

    const toNum = (v) => {
      if (v == null || v === "") return 0;
      const s = String(v).replace(".", "").replace(",", ".");
      const n = parseFloat(s);
      return isNaN(n) ? 0 : n;
    };

    // --- Construir datasets usando esas claves ---

    // 1) Departamentos Bolivia
    const deptos =
      keyCiudad && keyPctCiudad
        ? rows
            .filter((r) => r[keyCiudad] && r[keyPctCiudad] !== undefined)
            .map((r) => ({
              label: String(r[keyCiudad]).trim(),
              value: toNum(r[keyPctCiudad]),
            }))
        : [];

    // 2) Países
    const paises =
      keyPais && keyPctPais
        ? rows
            .filter((r) => r[keyPais] && r[keyPctPais] !== undefined)
            .map((r) => ({
              label: String(r[keyPais]).trim(),
              value: toNum(r[keyPctPais]),
            }))
        : [];

    // 3) Rango de edad / género
    const edades =
      keyRango && (keyHombre || keyMujer || keyTotalEdad)
        ? rows
            .filter((r) => r[keyRango])
            .map((r) => ({
              rango: String(r[keyRango]).trim(),
              hombres: toNum(r[keyHombre]),
              mujeres: toNum(r[keyMujer]),
              total: toNum(r[keyTotalEdad]),
            }))
            .filter((e) => e.rango !== "")
        : [];

    // 4) Páginas
    const paginas =
      keyPages && keyPctPage
        ? rows
            .filter((r) => r[keyPages] && r[keyPctPage] !== undefined)
            .map((r) => ({
              label: String(r[keyPages]).trim(),
              value: toNum(r[keyPctPage]),
            }))
        : [];

    // Dibujar solo si hay datos
    if (deptos.length) drawDeptosBo(deptos);
    if (paises.length) drawPaises(paises);
    if (edades.length) drawEdadGenero(edades);
    if (paginas.length) drawPaginas(paginas);

    // Si algo viene vacío, lo aviso en consola para debug
    if (!deptos.length) console.warn("Sin datos de departamentos (ciudad)");
    if (!paises.length) console.warn("Sin datos de países");
    if (!edades.length) console.warn("Sin datos de rangos de edad");
    if (!paginas.length) console.warn("Sin datos de páginas de interés");
  } catch (err) {
    console.error("Error Demografia:", err);
  }
}


// --------- Departamentos (barras horizontales) ----------
function drawDeptosBo(data) {
  destroyChart(chDeptosBo);
  const ctx = $("#chDeptosBo");
  if (!ctx || !data.length) return;

  const labels = data.map((d) => d.label);
  const values = data.map((d) => d.value);

  chDeptosBo = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "% de audiencia",
          data: values,
          backgroundColor: labels.map(() => COLORS.visual),
          borderRadius: 8,
          maxBarThickness: 22,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 800,
        easing: "easeOutQuart",
        delay: (ctx) => ctx.dataIndex * 50,
      },
      scales: {
        x: {
          ticks: {
            color: "#6b7280",
            callback: (v) => `${v}%`,
          },
          grid: { color: "rgba(148,163,184,0.18)" },
          suggestedMax: Math.max(...values, 10),
        },
        y: {
          ticks: { color: "#6b7280" },
          grid: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.parsed.x.toFixed(1)}%`,
          },
        },
      },
    },
  });
}

// --------- Paises (barras horizontales “llenándose”) ----------
function drawPaises(data) {
  destroyChart(chPais);
  const ctx = $("#chPais");
  if (!ctx || !data.length) return;

  const labels = data.map((d) => d.label);
  const values = data.map((d) => d.value);

  chPais = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "% de audiencia",
          data: values,
          backgroundColor: data.map((_, i) =>
            i === 0 ? COLORS.brand1 || COLORS.espec : COLORS.espec
          ),
          borderRadius: 10,
          maxBarThickness: 24,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 900,
        easing: "easeOutQuart",
        delay: (ctx) => ctx.dataIndex * 70,
      },
      scales: {
        x: {
          ticks: {
            color: "#6b7280",
            callback: (v) => `${v}%`,
          },
          grid: { color: "rgba(148,163,184,0.18)" },
          suggestedMax: Math.max(...values, 10),
        },
        y: {
          ticks: { color: "#6b7280" },
          grid: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.parsed.x.toFixed(2)}%`,
          },
        },
      },
    },
  });
}

// --------- Rango de edad y género (Hombres vs Mujeres lado a lado) ----------
function drawEdadGenero(data) {
  destroyChart(chEdadGenero);
  const ctx = $("#chEdadGenero");
  if (!ctx || !data.length) return;

  const labels  = data.map((d) => d.rango);
  const hombres = data.map((d) => d.hombres);
  const mujeres = data.map((d) => d.mujeres);

  chEdadGenero = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Hombres",
          data: hombres,
          backgroundColor: COLORS.visual,  // azul
          borderRadius: 6,
          maxBarThickness: 26,
        },
        {
          label: "Mujeres",
          data: mujeres,
          backgroundColor: COLORS.clics,   // morado
          borderRadius: 6,
          maxBarThickness: 26,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 800,
        easing: "easeOutQuart",
      },
      scales: {
        x: {
          // IMPORTANTE: sin stacked => barras lado a lado
          stacked: false,
          ticks: { color: "#6b7280" },
          grid: { display: false },
        },
        y: {
          stacked: false,
          beginAtZero: true,
          ticks: {
            color: "#6b7280",
            callback: (v) => `${v}%`,
          },
          grid: { color: "rgba(148,163,184,0.18)" },
        },
      },
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: "#111827",
              usePointStyle: true,
              pointStyle: "circle",
              boxWidth: 8,
              boxHeight: 8,
              padding: 18,
              font: {
                size: 11,
              },
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) =>
                `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
            },
          },
        },
    },
  });
}



// --------- Páginas de interés ----------
// --------- Páginas de interés ----------
function drawPaginas(data) {
  destroyChart(chPages);
  const ctx = $("#chPages");
  if (!ctx || !data.length) return;

  const labels = data.map((d) => d.label);
  const values = data.map((d) => d.value);
  const isMobile = window.innerWidth <= 640;

  chPages = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "% afinidad",
          data: values,
          backgroundColor: values.map((_, i) =>
            i < 3 ? COLORS.clics : COLORS.visitas
          ),
          borderRadius: 8,
          maxBarThickness: 30,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 800,
        easing: "easeOutQuart",
        delay: (ctx) => ctx.dataIndex * 60,
      },
      layout: {
        padding: {
          top: 4,
          right: 4,
          left: 4,
          bottom: isMobile ? 30 : 4, // más espacio abajo en móvil
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#6b7280",
            maxRotation: isMobile ? 60 : 0,
            minRotation: isMobile ? 40 : 0,
            autoSkip: isMobile ? true : false,
            autoSkipPadding: isMobile ? 12 : 0,
            font: {
              size: isMobile ? 9 : 11,
            },
            // En móvil partimos el texto en dos líneas si es muy largo
            callback: (value, index) => {
              const label = labels[index] || "";
              if (!isMobile) return label;

              if (label.length <= 18) return label;

              const words = label.split(" ");
              let l1 = "";
              let l2 = "";

              for (const w of words) {
                const test = (l1 ? l1 + " " : "") + w;
                if (test.length <= 18) {
                  l1 = test;
                } else {
                  l2 = (l2 ? l2 + " " : "") + w;
                }
              }
              return l2 ? [l1, l2] : l1; // array = multi-línea en Chart.js
            },
          },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: "#6b7280",
            callback: (v) => `${v}%`,
          },
          grid: { color: "rgba(148,163,184,0.18)" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.parsed.y.toFixed(2)}%`,
          },
        },
      },
    },
  });
}


// ---------- Excel (server-side) ----------
async function handleDescargarExcel() {
  if (!currentRows.length) {
    alert("No hay datos para exportar");
    return;
  }
  const mes = $("#mesSelect").value || "Mes";
  const semana = $("#semanaSelect").value;

  const resp = await fetch("/api/fbmetrics/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows: currentRows, month: mes, week: semana }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    alert("No se pudo generar el Excel en el servidor.\n" + t);
    return;
  }
  const blob = await resp.blob();
  const nom =
    semana === "all"
      ? `FB_Metricas_${mes}.xlsx`
      : `FB_Metricas_${mes}_Semana${semana}.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 2000);
}
