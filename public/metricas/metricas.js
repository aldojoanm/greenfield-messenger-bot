// ---- util
const $ = sel => document.querySelector(sel);
const fmt = n => Intl.NumberFormat('es-BO').format(n || 0);

// estado
let currentRows = [];
let chLine, chBar, chPie1, chPie2, chPie3;

// carga inicial
window.addEventListener('DOMContentLoaded', async () => {
  await cargarListadoMeses();       // llena el select con lo que exista en el Sheet
  const sel = $('#mesSelect');
  sel.addEventListener('change', () => cargarMes(sel.value));
  $('#btnXlsx').addEventListener('click', exportarExcelMesActual);

  // abre el último mes por defecto (última hoja)
  if (sel.options.length) {
    sel.selectedIndex = sel.options.length - 1;
    cargarMes(sel.value);
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
  const r = await fetch(`/api/fbmetrics/data?sheet=${encodeURIComponent(sheetName)}`);
  const j = await r.json();
  currentRows = j.rows || [];
  render(j.rows, sheetName);
}

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

function groupByWeekMonSun(rows){
  // Semana Lunes-Domingo
  const toDate = s => new Date(s + 'T00:00:00');
  const mondayOf = d => {
    const day = (d.getDay()+6)%7; // 0 lunes
    const m = new Date(d); m.setDate(d.getDate()-day);
    m.setHours(0,0,0,0); return m;
  };
  const endSun = d => { const e = new Date(d); e.setDate(e.getDate()+6); e.setHours(23,59,59,999); return e; };

  const map = new Map();
  for (const r of rows) {
    const d = toDate(r.Fecha);
    const monday = mondayOf(d);
    const key = monday.toISOString().slice(0,10);
    const cur = map.get(key) || { ini: monday, fin: endSun(monday), Visualizaciones:0, Clics:0, Visitas:0 };
    cur.Visualizaciones += +r.Visualizaciones || 0;
    cur.Clics += +r.Clics || 0;
    cur.Visitas += +r.Visitas || 0;
    map.set(key, cur);
  }
  return [...map.values()].sort((a,b)=>a.ini-b.ini);
}

function render(rows, sheetName){
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

function drawLine(rows){
  destroyChart(chLine);
  const ctx = $('#chLine');
  const labels = rows.map(r=>r.Fecha);
  chLine = new Chart(ctx, {
    type:'line',
    data:{
      labels,
      datasets:[
        { label:'Visualizaciones', data: rows.map(r=>r.Visualizaciones) },
        { label:'Espectadores',    data: rows.map(r=>r.Espectadores) },
        { label:'Clics',           data: rows.map(r=>r.Clics) }
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      scales:{ x:{ ticks:{ color:'#a3adc2', maxRotation:70, minRotation:70 } }, y:{ ticks:{ color:'#a3adc2' } } },
      plugins:{ legend:{ labels:{ color:'#eaf0ff' } } }
    }
  });
}

function drawBars(rows){
  destroyChart(chBar);
  const ctx = $('#chBar');
  const weeks = groupByWeekMonSun(rows);
  const labels = weeks.map(w=>`Sem ${fmtDate(w.ini)} a ${fmtDate(w.fin)}`);
  chBar = new Chart(ctx, {
    type:'bar',
    data:{
      labels,
      datasets:[
        { label:'Visualizaciones', data: weeks.map(w=>w.Visualizaciones) },
        { label:'Clics',           data: weeks.map(w=>w.Clics) },
        { label:'Visitas',         data: weeks.map(w=>w.Visitas) }
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      indexAxis:'x',
      scales:{ x:{ ticks:{ color:'#a3adc2', maxRotation:60, minRotation:60 } }, y:{ ticks:{ color:'#a3adc2' } } },
      plugins:{ legend:{ labels:{ color:'#eaf0ff' } } }
    }
  });
}
const fmtDate = d => d.toISOString().slice(0,10);

function drawPies(rows, tot){
  destroyChart(chPie1); destroyChart(chPie2); destroyChart(chPie3);
  chPie1 = new Chart($('#chPie1'), {
    type:'doughnut',
    data:{ labels:['Visualizaciones','Espectadores'],
      datasets:[{ data:[tot.Visualizaciones, tot.Espectadores] }] },
    options:{ plugins:{ legend:{ labels:{ color:'#eaf0ff' } } } }
  });
  chPie2 = new Chart($('#chPie2'), {
    type:'doughnut',
    data:{ labels:['Visitas','Clics'],
      datasets:[{ data:[tot.Visitas, tot.Clics] }] },
    options:{ plugins:{ legend:{ labels:{ color:'#eaf0ff' } } } }
  });
  chPie3 = new Chart($('#chPie3'), {
    type:'doughnut',
    data:{ labels:['Interacciones','Seguidores'],
      datasets:[{ data:[tot.Interacciones, tot.Seguidores] }] },
    options:{ plugins:{ legend:{ labels:{ color:'#eaf0ff' } } } }
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
  const sel = $('#mesSelect');
  if (!currentRows.length){ alert('No hay datos para exportar'); return; }
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(rowsToSheet(currentRows));
  const ws2 = XLSX.utils.aoa_to_sheet(kpiRows(currentRows));
  XLSX.utils.book_append_sheet(wb, ws1, 'Datos');
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumen');
  XLSX.writeFile(wb, `FB_Metricas_${sel.value}.xlsx`);
}
