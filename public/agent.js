// ====== Marca ======
const BRAND_NAME = document.querySelector('meta[name="brand:name"]')?.content?.trim() || 'New Chem Agroquímicos';
const BRAND_QR   = document.querySelector('meta[name="brand:qr"]')?.content?.trim()   || './qr-pagos.png';

// ====== Cuentas ======
const ACCOUNTS_TEXT = [
  `*Titular:* ${BRAND_NAME}`,
  '*Moneda:* Bolivianos',
  '',
  '*BCP*',          '*Cuenta Corriente:* 701-5096500-3-34', '',
  '*BANCO UNIÓN*',  '*Cuenta Corriente:* 10000047057563', '',
  '*BANCO SOL*',    '*Cuenta Corriente:* 2784368-000-001'
].join('\n');

// ====== DOM ======
const viewList   = document.getElementById('view-list');
const viewChat   = document.getElementById('view-chat');
const threadList = document.getElementById('threadList');
const msgCount   = document.getElementById('msgCount');
const elConn     = document.getElementById('conn');
const statusPill = document.getElementById('status');
const backBtn    = document.getElementById('backBtn');
const chatName   = document.getElementById('chatName');
const chatMeta   = document.getElementById('chatMeta');
const msgsEl     = document.getElementById('msgs');

const moreBtn     = document.getElementById('moreBtn');
const actionPanel = document.getElementById('actionPanel');
const fileInput   = document.getElementById('fileInput');
const dropZone    = document.getElementById('dropZone');
const box         = document.getElementById('box');
const sendBtn     = document.getElementById('send');

const refreshBtn = document.getElementById('refresh');
const importBtn  = document.getElementById('importWA');
const logoutBtn  = document.getElementById('logout');
const searchEl   = document.getElementById('search');
const segBtns    = Array.from(document.querySelectorAll('.segmented .seg'));

const toggleBotIcon  = document.getElementById('toggleBotIcon');
const toggleBotLabel = document.getElementById('toggleBotLabel');

// ====== Estado ======
let current = null;
let allConvos = [];
let sse = null;
let filter = 'all';
let pollTimer = null;

// ====== Utils ======
const isDesktop = () => window.matchMedia('(min-width:1024px)').matches;
const normId = v => String(v ?? '');
const sameId = (a,b)=> normId(a) === normId(b);
const looksLikeMediaLine = (t='')=> /^([🖼️🎬🎧📎])/.test(String(t).trim());

const pad2 = n => String(n).padStart(2,'0');
function isSameDay(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}
function isYesterday(d){
  const now = new Date();
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate()-1);
  return isSameDay(d, y);
}
// Estilo WhatsApp: hoy => HH:MM, ayer => "Ayer", mismo año => dd/MM, otro año => dd/MM/yy
function formatListStamp(ts){
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  const now = new Date();
  if (isSameDay(d, now)) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (isYesterday(d)) return 'Ayer';
  const dd = pad2(d.getDate()), mm = pad2(d.getMonth()+1);
  if (d.getFullYear() === now.getFullYear()) return `${dd}/${mm}`;
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
function fullStamp(ts){
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return d.toLocaleString();
}

const fmtBubbleStamp = (ts)=>{
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} • ${pad2(d.getDate())}/${pad2(d.getMonth()+1)}`;
};

const timeAgo = (ts)=> {
  if (!ts) return '';
  const d = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const diff = Math.max(1, Math.floor((Date.now()-d)/1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h`;
  return `${Math.floor(diff/86400)}d`;
};

// ===== iOS PWA safe-area/class =====
(function ensureDisplayModeClass(){
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) document.documentElement.classList.add('standalone');
})();

// ====== Token 24h / dispositivo ======
const TOKEN_TTL_MS = 24*60*60*1000;
const LS_TOKEN   = 'agent.token';
const LS_TOKENAT = 'agent.tokenAt';
const LS_DEVID   = 'agent.deviceId';

function deviceId(){
  let id = localStorage.getItem(LS_DEVID);
  if (!id){
    id = (crypto?.randomUUID?.() || (Date.now()+'-'+Math.random())).toString();
    localStorage.setItem(LS_DEVID, id);
  }
  return id;
}

const api = {
  token: localStorage.getItem(LS_TOKEN) || '',
  tokenAt: Number(localStorage.getItem(LS_TOKENAT) || 0),
  headers(){ return { 'Authorization':'Bearer '+this.token, 'Content-Type':'application/json', 'X-Device': deviceId() }; },
  isExpired(){ return !this.tokenAt || (Date.now() - this.tokenAt) > TOKEN_TTL_MS; },
  persist(t){ this.token=t; this.tokenAt=Date.now(); localStorage.setItem(LS_TOKEN,t); localStorage.setItem(LS_TOKENAT,String(this.tokenAt)); },
  clear(){ this.token=''; this.tokenAt=0; localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_TOKENAT); },
  async convos(){ const r = await fetch('/wa/agent/convos',{headers:this.headers()}); if(r.status===401){ await forceReauth(); return this.convos(); } if(!r.ok) throw 0; return r.json(); },
  async history(id){ const r = await fetch('/wa/agent/history/'+encodeURIComponent(id),{headers:this.headers()}); if(r.status===401){ await forceReauth(); return this.history(id); } if(!r.ok) throw 0; return r.json(); },
  async send(to,text){ const r = await fetch('/wa/agent/send',{method:'POST',headers:this.headers(),body:JSON.stringify({to,text})}); if(r.status===401){ await forceReauth(); return this.send(to,text); } if(!r.ok) throw 0; return r.json(); },
  async read(to){ const r = await fetch('/wa/agent/read',{method:'POST',headers:this.headers(),body:JSON.stringify({to})}); if(r.status===401){ await forceReauth(); return this.read(to); } if(!r.ok) throw 0; return r.json(); },
  async handoff(to,mode){ const r = await fetch('/wa/agent/handoff',{method:'POST',headers:this.headers(),body:JSON.stringify({to,mode})}); if(r.status===401){ await forceReauth(); return this.handoff(to,mode); } if(!r.ok) throw 0; return r.json(); },
  async sendMedia(to, files, caption=''){
    const fd = new FormData(); fd.append('to', to); fd.append('caption', caption);
    for (const f of files) fd.append('files', f, f.name);
    const r = await fetch('/wa/agent/send-media', { method:'POST', headers:{ 'Authorization':'Bearer '+this.token, 'X-Device': deviceId() }, body: fd });
    if (r.status===401){ await forceReauth(); return this.sendMedia(to, files, caption); }
    if (!r.ok) throw 0; return r.json();
  }
};

function setConn(status, title=''){
  const map = { ok:'Conectado', wait:'Conectando…', off:'Sin conexión' };
  elConn.textContent = (map[status]||'') + (title?` — ${title}`:'');
}

/* ===== SSE + polling ===== */
function startPolling(){ stopPolling(); pollTimer = setInterval(()=> refresh(false), 20000); }
function stopPolling(){ if (pollTimer){ clearInterval(pollTimer); pollTimer=null; } }

function startSSE(){
  try{ if (sse) sse.close(); }catch{}
  if (!api.token) return;
  sse = new EventSource('/wa/agent/stream?token=' + encodeURIComponent(api.token));
  setConn('ok'); stopPolling();

  sse.addEventListener('open', ()=> setConn('ok'));
  sse.addEventListener('ping', ()=> setConn('ok'));
  sse.addEventListener('msg', (ev)=>{
    const data = JSON.parse(ev.data||'{}');
    if(current && sameId(normId(data.id), current.id)){
      current.memory = (current.memory||[]).concat([{role:data.role, content:data.content, ts:data.ts}]);
      renderMsgs(current.memory);
    }
    refresh(false);
  });
  sse.onerror = ()=>{
    setConn('off','reintentando'); startPolling();
    try{ sse.close(); }catch{}; setTimeout(startSSE, 4000);
  };
}

async function requestToken(force=false){
  if (!force && api.token && !api.isExpired()) return true;
  while (true){
    const t = prompt('Token de agente (vigencia 24h en este dispositivo)');
    if (!t) { alert('Se requiere token para continuar.'); return false; }
    api.persist(t.trim());
    try{
      setConn('wait');
      const r = await fetch('/wa/agent/convos', { headers: api.headers() });
      if (r.status === 401){ alert('Token inválido. Intenta de nuevo.'); api.clear(); continue; }
      if (!r.ok){ alert('No pude validar el token. Reintenta.'); api.clear(); continue; }
      startSSE(); setConn('ok'); return true;
    }catch{ setConn('off'); alert('Error de red validando token. Reintenta.'); api.clear(); }
  }
}
async function forceReauth(){
  try{ if (sse) sse.close(); }catch{}
  api.clear(); setConn('off','sesión caducada');
  const ok = await requestToken(true); if (ok) await refresh(true);
}

document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible'){ setConn('wait','reconectando'); startSSE(); refresh(false); }});
window.addEventListener('pageshow', (e)=>{ if (e.persisted){ startSSE(); refresh(false); }});

// ====== LISTA ======
const lastFromMemory = (m=[]) => m.length ? m[m.length-1] : null;
const initial = (name='?') => name.trim()[0]?.toUpperCase?.() || '?';

// Heurística "done"
function inferDone(c){
  const status = (c.status||'').toLowerCase();
  if (['finalizado','finished','closed','done','completed'].includes(status)) return true;
  if (c.finalizado === true || c.done === true) return true;

  const K = /(cotizaci[oó]n|flujo\s+finalizado|pedido\s+enviado|orden\s+cerrada|gracias\s+por\s+su\s+compra)/i;
  if (K.test(String(c.last||''))) return true;

  const mem = c.memory || [];
  for (let i = mem.length-1; i >= Math.max(0, mem.length-10); i--){
    if (K.test(String(mem[i]?.content||''))) return true;
  }
  return false;
}
function hasFiles(c){
  const txt = String(c.last||'');
  return looksLikeMediaLine(txt) || /📎\s*Archivo/i.test(txt);
}

function fmtStamp(ts){
  if (!ts) return '';
  const d = (typeof ts === 'number') ? new Date(ts) : new Date(ts);
  const now = new Date();

  const pad = n => String(n).padStart(2,'0');
  const sameDate = (a,b)=> a.getFullYear()===b.getFullYear()
                        && a.getMonth()===b.getMonth()
                        && a.getDate()===b.getDate();

  if (sameDate(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const yest = new Date(now); yest.setDate(now.getDate()-1);
  if (sameDate(d, yest)) return 'Ayer';

  if (d.getFullYear() === now.getFullYear())
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}`;

  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${String(d.getFullYear()).slice(-2)}`;
}

function renderThreads(){
  threadList.innerHTML = '';
  const q = (searchEl.value||'').toLowerCase();
  let rows = allConvos.slice();

  // flags virtuales
  rows = rows.map(c=>{
    const done = inferDone(c);
    return { ...c, done, finalizado: done, files: hasFiles(c) };
  });

  // filtros por estado (usa tu variable "filter")
  if (filter==='done')    rows = rows.filter(c => c.done);
  if (filter==='active')  rows = rows.filter(c => !c.done);
  if (filter==='new')     rows = rows.filter(c => !c.done && !c.human && (c.unread>0));
  if (filter==='agent')   rows = rows.filter(c => c.human);
  if (filter==='unread')  rows = rows.filter(c => (c.unread||0)>0);
  if (filter==='files')   rows = rows.filter(c => c.files);

  // búsqueda por texto
  rows = rows.filter(c => (c.name||'').toLowerCase().includes(q) || String(c.id||'').includes(q));

  msgCount.textContent = `Mensajes (${rows.length})`;

  for (const c0 of rows){
    const c = {...c0, id: String(c0.id||'')};
    const lastMem = c.memory && c.memory.length ? c.memory[c.memory.length-1] : null;

    const ts = c.ts || lastMem?.ts || 0;
    const stamp = fmtStamp(ts);

    let lastTxt = String(c.last || lastMem?.content || '').replace(/\n/g,' ');
    const lastRole = lastMem?.role;
    const prefix = lastRole==='bot' || lastRole==='agent' ? 'You: ' : (c.name ? `${c.name}: ` : '');
    if (lastTxt) lastTxt = (prefix + lastTxt).slice(0,120);

    const dot = c.human ? 'agent' : (c.done ? 'done' : (c.unread ? 'unread' : 'done'));
    const avatar = c.avatar ? `<img src="${c.avatar}" alt="">`
                            : `<span>${(c.name||c.id).trim()[0]?.toUpperCase?.()||'?'}</span>`;

    const row = document.createElement('div');
    row.className = 'thread';
    row.innerHTML = `
      <div class="avatar">${avatar}</div>
      <div class="t-main">
        <div class="t-row1">
          <div class="t-name">${c.name || c.id}</div>
          <div class="t-time" title="${ts ? new Date(ts).toLocaleString() : ''}">${stamp}</div>
        </div>
        <div class="t-row2">
          <div class="t-last">${lastTxt || ''}</div>
          <span class="t-stamp">${stamp}</span>
        </div>
      </div>
      <div class="dot ${dot}" title="${dot}"></div>
    `;
    row.onclick = ()=> openChat(c.id);
    threadList.appendChild(row);
  }
}

// ====== CHAT ======
function renderMsgs(mem){
  msgsEl.innerHTML = '';
  for (const m of (mem||[])){
    const div = document.createElement('div');
    let cls = 'bubble sys';
    if (m.role==='user') cls = 'bubble user';
    else if (m.role==='bot') cls = 'bubble bot';
    else if (m.role==='agent') cls = 'bubble agent';
    div.className = cls;

    const txt = m.content ?? '';
    if (looksLikeMediaLine(txt)) {
      div.innerHTML = `<strong>${txt.slice(0,2)}</strong> ${txt.slice(2)}`;
    } else {
      div.textContent = txt;
    }

    // stamp en burbuja
    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = fmtBubbleStamp(m.ts || Date.now());
    div.appendChild(stamp);

    msgsEl.appendChild(div);
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function openChat(id){
  try{
    const res = await api.history(normId(id));
    current = {...res, id:normId(res.id)};
    chatName.textContent = current.name || current.id;
    chatMeta.textContent = current.phone ? current.phone : current.id;
    statusPill.style.display = current.human ? 'inline-block' : 'none';
    renderMsgs(current.memory||[]);
    await api.read(current.id).catch(()=>{});

    if (!isDesktop()){
      viewList.classList.remove('active');
      viewChat.classList.add('active');
    }
    refreshToggleUI(false);
  }catch{ alert('No pude abrir el chat.'); }
}
backBtn.onclick = ()=>{ current=null; viewChat.classList.remove('active'); viewList.classList.add('active'); };

// ===== Acciones comunes =====
async function doRequestInfo(){
  if (!current) return;
  const nombre = current.name?.trim() || 'cliente';
  const part1 = [
    `${nombre}, ¡gracias por su compra y confianza en ${BRAND_NAME}! 😊`,
    `Para *emitir su factura* y coordinar la fecha de entrega, por favor responda a este mensaje con los siguientes datos.`,
    `Te recordamos que la facturación debe emitirse al mismo nombre de la persona que realizó el pago.`,
    `¡Quedamos atentos y a su disposición para cualquier consulta!`
  ].join('\n');
  const part2 = [
   `*FACTURACIÓN*`,`• Razón social:`,`• NIT:`,``,
   `*ORDEN DE ENTREGA*`,`• Nombre del cliente: ${nombre}`,
   `• Nombre del chofer:`,`• Carnet de Identidad:`,`• Placa del vehículo:`,`• Fecha de recojo (dd/mm/aaaa):`
  ].join('\n');
  await api.send(current.id, part1);
  await api.send(current.id, part2);
}
async function doSendQR(){
  if (!current) return;
  const QR_URLS = [BRAND_QR, './qr-pagos.png'];
  let blob = null, mime = 'image/png';
  for (const u of QR_URLS){ try{ const r = await fetch(u); if (r.ok){ blob = await r.blob(); mime = blob.type || mime; break; } }catch{}
  }
  if (!blob){ alert('No encontré el archivo QR.'); return; }
  const file = new File([blob], 'qr-pagos.png', { type: mime });
  await api.sendMedia(current.id, [file], '');
}
async function doSendAccounts(){ if (!current) return; await api.send(current.id, ACCOUNTS_TEXT); }
async function doMarkRead(){ if(!current) return; await api.read(current.id); refresh(false); }
async function doTakeHuman(){ if(!current) return; await api.handoff(current.id,'human'); statusPill.style.display='inline-block'; refreshToggleUI(true); }
async function doResumeBot(){ if(!current) return; await api.handoff(current.id,'bot');   statusPill.style.display='none';         refreshToggleUI(true); }

// ===== Panel (móvil + desktop) =====
function refreshToggleUI(changed=false){
  if (!current) return;
  const isOn = !current.human;
  toggleBotIcon.src   = isOn ? '/iconos/icono-pausa.png' : '/iconos/icono-play.png';
  toggleBotLabel.textContent = isOn ? 'Apagar' : 'Encender';
  if (changed) setPanel(false);
}

function setPanel(open){
  panelOpen = !!open;
  actionPanel.classList.toggle('show', panelOpen);
  actionPanel.setAttribute('aria-hidden', String(!panelOpen));
  moreBtn.setAttribute('aria-expanded', String(panelOpen));
  const kbTpl = document.getElementById('tpl-keyboard-icon');
  moreBtn.innerHTML = panelOpen ? kbTpl.innerHTML
    : `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}
moreBtn.addEventListener('click', ()=> setPanel(!panelOpen));

document.getElementById('ap-location').onclick = async () => {
  if (!current) return;
  await api.send(
    current.id,
    '📍 Ubicación New Chem:\nhttps://maps.app.goo.gl/dSstZKuCA4HBBHZ3A'
  );
  setPanel(false);
};
document.getElementById('ap-qr').onclick = async ()=>{ await doSendQR(); setPanel(false); };
document.getElementById('ap-datos').onclick = async ()=>{ await doRequestInfo(); setPanel(false); };
document.getElementById('ap-cuentas').onclick = async ()=>{ await doSendAccounts(); setPanel(false); };
document.getElementById('ap-archivos').onclick = ()=>{ fileInput.click(); };

// Toggler robusto
document.getElementById('ap-toggle').onclick = async ()=>{
  if (!current) return;
  try {
    const fresh = await api.history(encodeURIComponent(current.id));
    current = {...fresh, id: String(fresh.id||current.id)};
  } catch {}
  const isOn = current ? !current.human : true;
  if (isOn) { await doTakeHuman(); } else { await doResumeBot(); }
};

// ===== Envío / inputs =====
sendBtn.onclick = async ()=>{
  const txt = box.value.trim();
  if(!txt || !current) return;
  box.value=''; await api.send(current.id, txt);
};
box.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendBtn.click(); } });

fileInput.onchange = async (e)=>{
  const files = Array.from(e.target.files||[]);
  if(!files.length || !current) return;
  try{ await api.sendMedia(current.id, files, ''); } catch{ alert('Error subiendo archivo(s).'); }
  e.target.value=''; setPanel(false);
};

// Drag&drop (solo desktop)
['dragenter','dragover'].forEach(ev=> dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag'); }));
['dragleave','drop'].forEach(ev=> dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', async (e)=>{ const files = Array.from(e.dataTransfer?.files||[]); if (!files.length || !current) return; try{ await api.sendMedia(current.id, files, ''); } catch{ alert('Error subiendo archivo(s).'); } });

// ===== Filtros =====
function renderList(){ renderThreads(); }
searchEl.oninput = renderList;
segBtns.forEach(b=> b.onclick = ()=>{ segBtns.forEach(x=>x.classList.remove('active')); b.classList.add('active'); filter = b.dataset.filter; renderList(); });

// ===== Datos =====
async function refresh(openFirst=false){
  try{
    const {convos} = await api.convos();
    allConvos = (convos||[]).map(c=>({...c, id:normId(c.id)}));
    renderList();
    if (openFirst && !current && allConvos.length && isDesktop()){
      openChat(allConvos[0].id);
    }
  }catch{}
}

// ==== Básicos ====
logoutBtn.onclick = ()=>{ api.clear(); localStorage.removeItem('agent.deviceId'); location.reload(); };

(async function(){
  const ok = await requestToken(false);
  if (!ok) return;
  await refresh(true);
  setInterval(()=>{ if (api.isExpired()) forceReauth(); }, 60*1000);
  startSSE();
})();

// PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(()=>{}); });
}
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',(e)=>{
  e.preventDefault(); deferredPrompt=e;
  const btn=document.createElement('button');
  btn.textContent='Instalar'; btn.className='btn';
  Object.assign(btn.style,{position:'fixed',right:'12px',bottom:'12px',zIndex:'9999'});
  document.body.appendChild(btn);
  btn.onclick=async()=>{ btn.disabled=true; try{ await deferredPrompt.prompt(); await deferredPrompt.userChoice; }finally{ btn.remove(); deferredPrompt=null; } };
});
window.addEventListener('offline', ()=> setConn('off','sin red'));
window.addEventListener('online',  ()=> { setConn('wait','reconectando'); startSSE(); });

// iOS: cuando el panel está abierto, reduce rebote
let panelOpen=false;
document.addEventListener('touchmove', (e)=>{ if (panelOpen) e.stopPropagation(); }, {passive:true});
