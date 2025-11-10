// ---- util
const $  = sel => document.querySelector(sel);
const fmt = n => Intl.NumberFormat('es-BO').format(n || 0);

// Evita renders ultra densos en HiDPI
if (window.Chart) {
  Chart.defaults.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
}

// Estado
let allRows = [];          // mes completo
let currentRows = [];      // filtrado por semana
let weekBuckets = [];      // [{ini, fin, rows}]
let activeMetric = null;   // 'Visualizaciones' | ... | null

let chLine, chBar, chPieAll, chPie1, chPie2, chPie3, chPieSel;

// Carga inicial
window.addEventListener('DOMContentLoaded', async () => {
  await cargarListadoMeses();
  const selMes = $('#mesSelect');
  const selSem = $('#semanaSelect');

  selMes.addEventListener('change', () => cargarMes(selMes.value));
  selSem.addEventListener('change', () => aplicarSemana(selSem.value));
  $('#btnXlsx').addEventListener('click', handleDescargarExcel);

  // KPI click -> filtro por métrica (toggle)
  document.querySelectorAll('.kpi').forEach(k => {
    k.addEventListener('click', () => {
      const m = k.dataset.metric;
      activeMetric = (activeMetric === m) ? null : m;
      document.querySelectorAll('.kpi')
        .forEach(x => x.classList.toggle('active', x.dataset.metric === activeMetric));
      render(currentRows);
    });
  });

  // Abre el último mes por defecto
  if (selMes.options.length) {
    selMes.selectedIndex = selMes.options.length - 1;
    await cargarMes(selMes.value);
  }
});

// --------- Fetch helpers ---------
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
  const r = await fetch(`/api/fbmetrics/data?sheet=${encodeURIComponent(sheetName)}`);
  const j = await r.json();
  allRows = (j.rows || []).slice();

  weekBuckets = buildWeekBuckets(allRows);

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

// --------- Semanas (L-D) ----------
const toDate  = s => new Date(s + 'T00:00:00');
const mondayOf= d => { const day=(d.getDay()+6)%7; const m=new Date(d); m.setDate(d.getDate()-day); m.setHours(0,0,0,0); return m; };
const endSun  = d => { const e=new Date(d); e.setDate(e.getDate()+6); e.setHours(23,59,59,999); return e; };
const fmtDate = d => d.toISOString().slice(0,10);

function buildWeekBuckets(rows){
  const map = new Map(); // mondayISO -> {ini, fin, rows:[]}
  for (const r of rows) {
    const d = toDate(r.Fecha);
    const monday = mondayOf(d);
    const key = monday.toISOString().slice(0,10);
    const cur = map.get(key) || { ini:monday, fin:endSun(monday), rows:[] };
    cur.rows.push(r);
    map.set(key, cur);
  }
  return [...map.values()].sort((a,b)=>a.ini-b.ini);
}

// --------- Totales ----------
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
  const tot = aggTotals(rows);

  // KPIs
  $('#kpi-visual').textContent   = fmt(tot.Visualizaciones);
  $('#kpi-espec').textContent    = fmt(tot.Espectadores);
  $('#kpi-inter').textContent    = fmt(tot.Interacciones);
  $('#kpi-visitas').textContent  = fmt(tot.Visitas);
  $('#kpi-clics').textContent    = fmt(tot.Clics);
  $('#kpi-seg').textContent      = fmt(tot.Seguidores);

  // Tabla
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

  // Charts
  drawLine(rows);
  drawBars(rows);
  drawPies(rows, tot);
}

function destroyChart(c){ if (c && typeof c.destroy==='function') c.destroy(); }

// --------- Línea diaria ----------
function drawLine(rows){
  destroyChart(chLine);
  const ctx = $('#chLine');
  const labels = rows.map(r=>r.Fecha);

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
      responsive:true, maintainAspectRatio:false, animation:false,
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

// --------- Barras por semana ----------
function drawBars(rows){
  destroyChart(chBar);
  const ctx = $('#chBar');
  const buckets = buildWeekBuckets(rows);

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
      responsive:true, maintainAspectRatio:false, animation:false,
      layout:{ padding:8 },
      scales:{
        x:{ ticks:{ color:'#a3adc2', maxRotation:0, autoSkip:true, autoSkipPadding:8 } },
        y:{ ticks:{ color:'#a3adc2' }, grid:{ color:'rgba(255,255,255,.06)' } }
      },
      plugins:{ legend:{ position:'bottom', labels:{ color:'#eaf0ff', boxWidth:12 } } }
    }
  });
}

// --------- Donas ----------
function drawPies(rows, tot){
  destroyChart(chPieAll); destroyChart(chPie1); destroyChart(chPie2); destroyChart(chPie3); destroyChart(chPieSel);

  // Dona “Todos los KPIs”
  chPieAll = new Chart($('#chPieAll'), {
    type:'doughnut',
    data:{
      labels:['Visualizaciones','Espectadores','Interacciones','Visitas','Clics','Seguidores'],
      datasets:[{ data:[tot.Visualizaciones, tot.Espectadores, tot.Interacciones, tot.Visitas, tot.Clics, tot.Seguidores] }]
    },
    options:pieOpts()
  });

  // Parejas
  chPie1 = new Chart($('#chPie1'), {
    type:'doughnut',
    data:{ labels:['Visualizaciones','Espectadores'], datasets:[{ data:[tot.Visualizaciones, tot.Espectadores] }] },
    options:pieOpts()
  });
  chPie2 = new Chart($('#chPie2'), {
    type:'doughnut',
    data:{ labels:['Visitas','Clics'], datasets:[{ data:[tot.Visitas, tot.Clics] }] },
    options:pieOpts()
  });
  chPie3 = new Chart($('#chPie3'), {
    type:'doughnut',
    data:{ labels:['Interacciones','Seguidores'], datasets:[{ data:[tot.Interacciones, tot.Seguidores] }] },
    options:pieOpts()
  });

  // Extra: participación de la métrica seleccionada
  const selWrap = $('#pieSelWrap');
  if (activeMetric){
    selWrap.classList.remove('hidden');
    const totalSel = tot[activeMetric] || 0;
    const totalAll = Object.values(tot).reduce((a,b)=>a+b,0);
    const otros = Math.max(0,totalAll - totalSel);
    chPieSel = new Chart($('#chPieSel'), {
      type:'doughnut',
      data:{ labels:[activeMetric,'Otros KPIs'], datasets:[{ data:[totalSel, otros] }] },
      options:pieOpts()
    });
  } else {
    selWrap.classList.add('hidden');
  }
}

function pieOpts(){
  return {
    responsive:true, maintainAspectRatio:false, animation:false,
    cutout:'65%',
    layout:{ padding:8 },
    plugins:{
      legend:{ position:'bottom', labels:{ color:'#eaf0ff', boxWidth:12 } },
      tooltip:{ enabled:true }
    },
    elements:{ arc:{ borderWidth:0 } }
  };
}

// ---------- Excel (server-side) ----------
async function handleDescargarExcel(){
  if (!currentRows.length){
    alert('No hay datos para exportar');
    return;
  }
  const mes = $('#mesSelect').value || 'Mes';
  const semana = $('#semanaSelect').value;

  const resp = await fetch('/api/fbmetrics/export', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ rows: currentRows, month: mes, week: semana })
  });
  if (!resp.ok){
    const t = await resp.text().catch(()=> '');
    alert('No se pudo generar el Excel en el servidor.\n' + t);
    return;
  }
  const blob = await resp.blob();
  const nom = semana === 'all' ? `FB_Metricas_${mes}.xlsx` : `FB_Metricas_${mes}_Semana${semana}.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nom; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 2000);
}
