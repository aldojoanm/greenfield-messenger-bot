// ---- util
const $ = sel => document.querySelector(sel);
const fmt = n => Intl.NumberFormat('es-BO').format(n || 0);

// controla que el canvas no sea gigante en pantallas HiDPI
if (window.Chart) {
  Chart.defaults.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
}

// estado
let allRows = [];          // mes completo
let currentRows = [];      // filtrado por semana
let weekBuckets = [];      // [{key, ini, fin, rows}]
let activeMetric = null;   // 'Visualizaciones' | ... | null

let chLine, chBar, chPie1, chPie2, chPie3, chPieSel;

// carga inicial
window.addEventListener('DOMContentLoaded', async () => {
  await cargarListadoMeses();       // llena el select con lo que exista en el Sheet
  const selMes = $('#mesSelect');
  const selSem = $('#semanaSelect');

  selMes.addEventListener('change', () => cargarMes(selMes.value));
  selSem.addEventListener('change', () => aplicarSemana(selSem.value));
  $('#btnXlsx').addEventListener('click', exportarExcelMesActual);

  // KPI click -> filtro por métrica
  document.querySelectorAll('.kpi').forEach(k => {
    k.addEventListener('click', () => {
      const m = k.dataset.metric;
      activeMetric = (activeMetric === m) ? null : m;
      document.querySelectorAll('.kpi').forEach(x => x.classList.toggle('active', x.dataset.metric === activeMetric));
      render(currentRows); // re-render con el filtro de métrica
    });
  });

  // abre el último mes por defecto (última hoja)
  if (selMes.options.length) {
    selMes.selectedIndex = selMes.options.length - 1;
    await cargarMes(selMes.value);
  }
});

async function cargarListadoMeses(){
  const r = await fetch('/api/fbmetrics/sheets');
  const j = await r.json();
  const sel = $('#mesSelect');
  sel.innerHTML = '';
  (j.sheets || []).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
}

async function cargarMes(sheetName){
  // lee datos
  const r = await fetch(`/api/fbmetrics/data?sheet=${encodeURIComponent(sheetName)}`);
  const j = await r.json();
  allRows = (j.rows || []).slice();

  // arma buckets de semana (L-D) *dentro del mes*
  weekBuckets = buildWeekBuckets(allRows);

  // llena el selector de semana
  const sel = $('#semanaSelect');
  sel.innerHTML = '<option value="all">Todo el mes</option>';
  weekBuckets.forEach((w, i) => {
    const opt = document.createElement('option');
    opt.value = String(i+1);
    opt.textContent = `Semana ${i+1} (${fmtDate(w.ini)} a ${fmtDate(w.fin)})`;
    sel.appendChild(opt);
  });
  sel.value = 'all';

  aplicarSemana('all');
}

function aplicarSemana(val){
  currentRows = (val === 'all') ? allRows : (weekBuckets[+val - 1]?.rows || []);
  render(currentRows);
}

// ----- helpers de fechas / semanas -----
const toDate = s => new Date(s + 'T00:00:00');
const mondayOf = d => { const day = (d.getDay()+6)%7; const m = new Date(d); m.setDate(d.getDate()-day); m.setHours(0,0,0,0); return m; };
const endSun   = d => { const e = new Date(d); e.setDate(e.getDate()+6); e.setHours(23,59,59,999); return e; };
const fmtDate  = d => d.toISOString().slice(0,10);

function buildWeekBuckets(rows){
  // agrupa por L-D pero SOLO semanas que caen dentro del mes de las filas
  const map = new Map();   // mondayISO -> {ini, fin, rows:[]}
  for (const r of rows) {
    const d = toDate(r.Fecha);
    const monday = mondayOf(d);
    const key = monday.toISOString().slice(0,10);
    const cur = map.get(key) || { ini: monday, fin: endSun(monday), rows:[] };
    cur.rows.push(r);
    map.set(key, cur);
  }
  return [...map.values()].sort((a,b)=>a.ini-b.ini);
}

// ----- agregados / totales -----
function aggTotals(rows){
  const sum = (k) => rows.reduce((a,b)=>a+(+b[k]||0),0);
  return {
    Interacciones: sum('Interacciones'),
    Visualizaciones: sum('Visualizaciones'),
    Espectadores: sum('Espectadores'),
    Visitas: sum('Visitas'),
    Clics: sum('Clics'),
    Seguidores: sum('Seguidores'),
  };
}

// ==================== RENDER ====================
function render(rows){
  // KPIs
  const tot = aggTotals(rows);
  $('#kpi-visual').textContent   = fmt(tot.Visualizaciones);
  $('#kpi-espec').textContent    = fmt(tot.Espectadores);
  $('#kpi-inter').textContent    = fmt(tot.Interacciones);
  $('#kpi-visitas').textContent  = fmt(tot.Visitas);
  $('#kpi-clics').textContent    = fmt(tot.Clics);
  $('#kpi-seg').textContent      = fmt(tot.Seguidores);

  // tabla
  const tbl = $('#tbl');
  const head = `
    <tr>
      <th>Fecha</th><th>Interacciones</th><th>Visualizaciones</th><th>Espectadores</th>
      <th>Visitas</th><th>Clics</th><th>Seguidores</th>
    </tr>`;
  const body = rows.map(r=>`
    <tr>
      <td>${r.Fecha}</td>
      <td>${fmt(r.Interacciones)}</td>
      <td>${fmt(r.Visualizaciones)}</td>
      <td>${fmt(r.Espectadores)}</td>
      <td>${fmt(r.Visitas)}</td>
      <td>${fmt(r.Clics)}</td>
      <td>${fmt(r.Seguidores)}</td>
    </tr>`).join('');
  tbl.innerHTML = head + body;

  // gráficos
  drawLine(rows);
  drawBars(rows);
  drawPies(rows, tot);
}

function destroyChart(c){ if (c && typeof c.destroy==='function') c.destroy(); }

// ===== Linea diaria =====
function drawLine(rows){
  destroyChart(chLine);
  const ctx = $('#chLine');
  const labels = rows.map(r=>r.Fecha);

  // datasets según filtro de KPI
  const datasets = [];
  const add = (label, key) => datasets.push({ label, data: rows.map(r=>r[key]) });
  const want = (m) => !activeMetric || activeMetric === m;

  if (want('Visualizaciones')) add('Visualizaciones','Visualizaciones');
  if (want('Espectadores'))    add('Espectadores','Espectadores');
  if (want('Clics'))           add('Clics','Clics');
  if (want('Visitas'))         add('Visitas','Visitas');
  if (want('Interacciones'))   add('Interacciones','Interacciones');
  if (want('Seguidores'))      add('Seguidores','Seguidores');

  chLine = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:false,
      layout:{ padding:8 },
      interaction:{ mode:'index', intersect:false },
      scales:{
        x:{ ticks:{ color:'#a3adc2', maxRotation:0, autoSkip:true, autoSkipPadding:8 } },
        y:{ ticks:{ color:'#a3adc2' }, grid:{ color:'rgba(255,255,255,.06)' } }
      },
      plugins:{
        legend:{ position:'bottom', labels:{ color:'#eaf0ff', boxWidth:12 } },
        tooltip:{ mode:'index', intersect:false }
      }
    }
  });
}

// ===== Barras por semana =====
function drawBars(rows){
  destroyChart(chBar);
  const ctx = $('#chBar');

  // si ya venimos filtrados por una semana, agrego un solo bucket de esa semana
  const buckets = buildWeekBuckets(rows);

  // tomar métricas visibles
  const want = (m) => !activeMetric || activeMetric === m;
  const labels = buckets.map(w=>`Sem ${fmtDate(w.ini)} a ${fmtDate(w.fin)}`);
  const sum = (list, key) => list.reduce((a,b)=>a + (+b[key]||0), 0);

  const datasets = [];
  if (want('Visualizaciones')) datasets.push({ label:'Visualizaciones', data:buckets.map(b=>sum(b.rows,'Visualizaciones')) });
  if (want('Clics'))           datasets.push({ label:'Clics',           data:buckets.map(b=>sum(b.rows,'Clics')) });
  if (want('Visitas'))         datasets.push({ label:'Visitas',         data:buckets.map(b=>sum(b.rows,'Visitas')) });
  if (want('Espectadores'))    datasets.push({ label:'Espectadores',    data:buckets.map(b=>sum(b.rows,'Espectadores')) });
  if (want('Interacciones'))   datasets.push({ label:'Interacciones',   data:buckets.map(b=>sum(b.rows,'Interacciones')) });
  if (want('Seguidores'))      datasets.push({ label:'Seguidores',      data:buckets.map(b=>sum(b.rows,'Seguidores')) });

  chBar = new Chart(ctx, {
    type:'bar',
    data:{ labels, datasets },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:false,
      layout:{ padding:8 },
      scales:{
        x:{ ticks:{ color:'#a3adc2', maxRotation:0, autoSkip:true, autoSkipPadding:8 } },
        y:{ ticks:{ color:'#a3adc2' }, grid:{ color:'rgba(255,255,255,.06)' } }
      },
      plugins:{ legend:{ position:'bottom', labels:{ color:'#eaf0ff', boxWidth:12 } } }
    }
  });
}

// ===== Tortas =====
function drawPies(rows, tot){
  destroyChart(chPie1); destroyChart(chPie2); destroyChart(chPie3); destroyChart(chPieSel);

  const pies3 = $('#pies3');
  const selWrap = $('#pieSelWrap');

  // si hay filtro de KPI, muestro UNA sola dona: métrica vs resto
  if (activeMetric){
    pies3.classList.add('hidden');
    selWrap.classList.remove('hidden');

    const totalSel = tot[activeMetric] || 0;
    const totalAll = Object.values(tot).reduce((a,b)=>a+b,0);
    const otros = Math.max(0,totalAll - totalSel);

    chPieSel = new Chart($('#chPieSel'), {
      type:'doughnut',
      data:{ labels:[activeMetric,'Otros KPIs'], datasets:[{ data:[totalSel, otros] }] },
      options:{
        responsive:true, maintainAspectRatio:false, cutout:'65%', animation:false,
        plugins:{ legend:{ position:'bottom', labels:{ color:'#eaf0ff', boxWidth:12 } } },
        elements:{ arc:{ borderWidth:0 } }
      }
    });
    return;
  }

  // si no hay filtro, muestro 3 donas
  pies3.classList.remove('hidden');
  selWrap.classList.add('hidden');

  const common = {
    type:'doughnut',
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'65%', animation:false,
      plugins:{ legend:{ position:'bottom', labels:{ color:'#eaf0ff', boxWidth:12 } } },
      elements:{ arc:{ borderWidth:0 } }
    }
  };
  chPie1 = new Chart($('#chPie1'), {
    ...common,
    data:{ labels:['Visualizaciones','Espectadores'],
      datasets:[{ data:[tot.Visualizaciones, tot.Espectadores] }] }
  });
  chPie2 = new Chart($('#chPie2'), {
    ...common,
    data:{ labels:['Visitas','Clics'],
      datasets:[{ data:[tot.Visitas, tot.Clics] }] }
  });
  chPie3 = new Chart($('#chPie3'), {
    ...common,
    data:{ labels:['Interacciones','Seguidores'],
      datasets:[{ data:[tot.Interacciones, tot.Seguidores] }] }
  });
}

// ---------- Exportar Excel (Datos + Resumen) ----------
function rowsToSheet(rows){
  const header = ['Fecha','Interacciones','Visualizaciones','Espectadores','Visitas','Clics','Seguidores'];
  const body = rows.map(r=>[r.Fecha,r.Interacciones,r.Visualizaciones,r.Espectadores,r.Visitas,r.Clics,r.Seguidores]);
  return [header, ...body];
}
function kpiRows(rows){
  const t = aggTotals(rows);
  return [
    ['KPI','Valor'],
    ['Interacciones', t.Interacciones],
    ['Visualizaciones', t.Visualizaciones],
    ['Espectadores', t.Espectadores],
    ['Visitas', t.Visitas],
    ['Clics', t.Clics],
    ['Seguidores', t.Seguidores],
  ];
}
function exportarExcelMesActual(){
  if (!currentRows.length){
    alert('No hay datos para exportar');
    return;
  }
  const mes = $('#mesSelect').value || 'Mes';
  const periodo = $('#semanaSelect').value;
  const nom = periodo === 'all' ? `FB_Metricas_${mes}.xlsx` : `FB_Metricas_${mes}_Semana${periodo}.xlsx`;

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(rowsToSheet(currentRows));
  const ws2 = XLSX.utils.aoa_to_sheet(kpiRows(currentRows));
  XLSX.utils.book_append_sheet(wb, ws1, 'Datos');
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumen');
  XLSX.writeFile(wb, nom);
}
