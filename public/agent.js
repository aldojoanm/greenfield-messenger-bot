// ====== Marca / QR ======
const BRAND_NAME = document.querySelector('meta[name="brand:name"]')?.content?.trim() || 'New Chem Agroquímicos SRL';
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
const app = document.getElementById('app');
const elList = document.getElementById('list');
const elMsgs = document.getElementById('msgs');
const elTitle= document.getElementById('title');
const elStatus= document.getElementById('status');
const elConn = document.getElementById('conn');
const box = document.getElementById('box');
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const attachBtn = document.getElementById('attachBtn');

// ===== iOS PWA safe-area/class =====
(function ensureDisplayModeClass(){
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) document.documentElement.classList.add('standalone');
})();

// ====== Estado / helpers ======
let current = null;
let allConvos = [];
let sse = null;
const TOKEN_TTL_MS = 24*60*60*1000;
const LS_TOKEN='agent.token', LS_TOKENAT='agent.tokenAt', LS_DEVID='agent.deviceId';

const normId = v => String(v ?? '');
const sameId = (a,b)=> normId(a) === normId(b);
function looksLikeMediaLine(t=''){ return /^([🖼️🎬🎧📎])/.test(String(t).trim()); }
const isDesktop = ()=> window.matchMedia('(min-width:900px)').matches;

// ====== Device id y conexión ======
function deviceId(){
  let id = localStorage.getItem(LS_DEVID);
  if (!id){
    id = (crypto?.randomUUID?.() || (Date.now()+'-'+Math.random())).toString();
    localStorage.setItem(LS_DEVID, id);
  }
  return id;
}
function setConn(status, title=''){
  const map = { ok:'Conectado', wait:'Conectando…', off:'Sin conexión' };
  elConn.textContent = (map[status]||'') + (title?` — ${title}`:'');
}

// ====== API con reauth ======
const api = {
  token: localStorage.getItem(LS_TOKEN) || '',
  tokenAt: Number(localStorage.getItem(LS_TOKENAT) || 0),
  headers(){
    return { 'Authorization':'Bearer '+this.token, 'Content-Type':'application/json', 'X-Device': deviceId() };
  },
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

// ===== SSE con reconexión y fallback =====
let pollTimer=null;
function startPolling(){ stopPolling(); pollTimer=setInterval(()=> refresh(false), 20000); }
function stopPolling(){ if (pollTimer){ clearInterval(pollTimer); pollTimer=null; } }

function startSSE(){
  try{ if (sse) sse.close(); }catch{}
  if (!api.token) return;
  const url = '/wa/agent/stream?token=' + encodeURIComponent(api.token);
  sse = new EventSource(url);
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
    setConn('off','reintentando');
    startPolling();
    try{ sse.close(); }catch{}
    setTimeout(startSSE, 4000);
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

// ===== Lista / Chat =====
function renderList(filter=''){
  elList.innerHTML=''; const q = (filter||'').toLowerCase();
  for(const c0 of (allConvos||[])){
    const c = {...c0, id: normId(c0.id)};
    if(q && !String(c.name||'').toLowerCase().includes(q) && !c.id.includes(q)) continue;
    const row = document.createElement('div');
    const isActive = current && sameId(c.id, current.id);
    row.className = 'item'+(isActive?' active':'' ); row.onclick = ()=> openChat(c.id);
    const last = String(c.last||'').replace(/\n/g,' · ');
    row.innerHTML = `
      <div>
        <div class="name">${c.name||c.id}</div>
        <div class="sub">${last.slice(0,90)}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        ${c.human?'<span class="pill human">HUMANO</span>':''}
        ${c.unread?`<span class="pill">${c.unread}</span>`:''}
      </div>`;
    elList.appendChild(row);
  }
}
function renderMsgs(mem){
  elMsgs.innerHTML = '';
  for(const m of (mem||[])){
    const div = document.createElement('div');
    let cls='bubble sys';
    if(m.role==='user') cls='bubble u';
    else if(m.role==='bot') cls='bubble b';
    else if(m.role==='agent') cls='bubble a';
    div.className = cls;
    const txt = m.content ?? '';
    if (looksLikeMediaLine(txt)) div.innerHTML = `<strong>${txt.slice(0,2)}</strong> ${txt.slice(2)}`;
    else div.textContent = txt;
    elMsgs.appendChild(div);
  }
  elMsgs.scrollTop = elMsgs.scrollHeight;
}
async function openChat(id){
  try{
    const res = await api.history(normId(id));
    current = {...res, id:normId(res.id)};
    elTitle.textContent = `${current.name||current.id} (${current.id})`;
    elStatus.style.display = current.human ? 'inline-block' : 'none';
    elStatus.textContent = current.human ? 'HUMANO' : '';
    renderMsgs(current.memory||[]);
    sessionStorage.setItem('lastChatId', current.id);
    api.read(current.id).catch(()=>{});
    refresh(false);
    if (window.innerWidth<900) app.classList.remove('show-left');
  }catch(e){
    elTitle.textContent = normId(id);
    elStatus.style.display='none';
  }
}

// ===== Acciones =====
document.getElementById('requestInfo').onclick = async ()=>{
  if(!current) return;
  const nombre = (current && current.name) ? current.name.trim() : 'cliente';
  const part1 = [
    `${nombre}, ¡gracias por su compra y confianza en ${BRAND_NAME}! 😊`,
    `Para *emitir su factura* y coordinar la fecha de entrega, por favor responda a este mensaje con los siguientes datos.`,
    `Te recordamos que la facturación debe emitirse al mismo nombre de la persona que realizó el pago.`,
    `¡Quedamos atentos y a su disposición para cualquier consulta!`
  ].join('\n');
  const part2 = [
    `*FACTURACIÓN*`,
    `• Razón social:`,
    `• NIT:`,
    ``,
    `*ORDEN DE ENTREGA*`,
    `• Nombre del cliente: ${nombre}`,
    `• Nombre del chofer:`,
    `• Carnet de Identidad:`,
    `• Placa del vehículo:`,
    `• Fecha de recojo (dd/mm/aaaa):`
  ].join('\n');
  await api.send(current.id, part1);
  await api.send(current.id, part2);
};

document.getElementById('sendQR').onclick = async ()=>{
  if(!current) return;
  const QR_URLS = [BRAND_QR, './qr-pagos.png', '/qr-pagos.png', '/public/qr-pagos.png'];
  let blob = null, mime = 'image/png';
  for (const u of QR_URLS){ try{ const r = await fetch(u); if (r.ok){ blob = await r.blob(); mime = blob.type || mime; break; } }catch{} }
  if(!blob){ alert('No encontré el archivo QR.'); return; }
  const file = new File([blob], 'qr-pagos.png', { type: mime });
  await api.sendMedia(current.id, [file], '');
};

document.getElementById('sendAccounts').onclick = async ()=>{
  if(!current) return;
  await api.send(current.id, ACCOUNTS_TEXT);
};

document.getElementById('markRead').onclick = async ()=>{ if(!current) return; await api.read(current.id); refresh(false); };
document.getElementById('takeHuman').onclick = async ()=>{ if(!current) return; await api.handoff(current.id,'human'); elStatus.style.display='inline-block'; elStatus.textContent='HUMANO'; };
document.getElementById('resumeBot').onclick = async ()=>{ if(!current) return; await api.handoff(current.id,'bot'); elStatus.style.display='none'; };

document.getElementById('refresh').onclick = ()=> refresh(true);
document.getElementById('logout').onclick = ()=>{ try{ if (sse) sse.close(); }catch{} api.clear(); localStorage.removeItem(LS_DEVID); location.reload(); };
document.getElementById('search').oninput = (e)=> renderList(e.target.value);
document.getElementById('toggleLeft').onclick = ()=> app.classList.toggle('show-left');

// ===== Envío / Adjuntos / Drag & Drop =====
document.getElementById('send').onclick = async ()=>{
  const txt = box.value.trim(); if(!txt || !current) return;
  box.value=''; await api.send(current.id, txt);
};
box.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); document.getElementById('send').click(); } });

document.getElementById('attachBtn').onclick = ()=> fileInput.click();
fileInput.onchange = async (e)=>{
  const files = Array.from(e.target.files||[]);
  if(!files.length || !current) return;
  try{ await api.sendMedia(current.id, files, ''); } catch{ alert('Error subiendo archivo(s).'); }
  e.target.value='';
};
['dragenter','dragover'].forEach(ev=> dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag'); }));
['dragleave','drop'].forEach(ev=> dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', async (e)=>{
  const files = Array.from(e.dataTransfer?.files||[]); if (!files.length || !current) return;
  try{ await api.sendMedia(current.id, files, ''); } catch{ alert('Error subiendo archivo(s).'); }
});

// ===== Datos =====
async function refresh(openFirst=false){
  try{
    const {convos} = await api.convos();
    allConvos = (convos||[]).map(c=>({...c,id:normId(c.id)}));
    renderList(document.getElementById('search').value);
    if (openFirst && !current && allConvos.length && isDesktop()){
      const last = sessionStorage.getItem('lastChatId');
      const fallback = last && allConvos.find(c=>sameId(c.id,last)) ? last : allConvos[0].id;
      openChat(fallback);
    }
  }catch{}
}

// ===== Importar WA =====
document.getElementById('importWA').onclick = async ()=>{
  try{
    const r = await fetch('/wa/agent/import-whatsapp', {
      method: 'POST',
      headers: api.headers(),
      body: JSON.stringify({ days: 3650 })
    });
    if (r.status === 401){ await forceReauth(); return document.getElementById('importWA').click(); }
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || 'Error');
    alert(`Listo. Importados ${j.imported} chats.`);
    await refresh(true);
    if (window.innerWidth < 900) app.classList.add('show-left');
  }catch{ alert('No se pudo importar desde Sheets.'); }
};

// ===== Bootstrap =====
(async function(){
  const ok = await requestToken(false);
  if (!ok) return;
  await refresh(true);
  setInterval(()=>{ if (api.isExpired()) forceReauth(); }, 60*1000);
  startSSE();
})();

// ===== PWA (opcional; no rompe si faltan archivos) =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  });
}
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',(e)=>{
  e.preventDefault(); deferredPrompt=e;
  const btn=document.createElement('button');
  btn.textContent='Instalar'; btn.className='btn sm';
  Object.assign(btn.style,{position:'fixed',right:'12px',bottom:'12px',zIndex:'9999'});
  document.body.appendChild(btn);
  btn.onclick=async()=>{ btn.disabled=true; try{ await deferredPrompt.prompt(); await deferredPrompt.userChoice; }finally{ btn.remove(); deferredPrompt=null; } };
});
window.addEventListener('offline', ()=> setConn('off','sin red'));
window.addEventListener('online',  ()=> { setConn('wait','reconectando'); startSSE(); });
