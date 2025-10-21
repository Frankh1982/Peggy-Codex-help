const logEl  = document.getElementById('log');
const form   = document.getElementById('chat');
const input  = document.getElementById('msg');
const sendBtn= document.getElementById('send');

const pillProj  = document.getElementById('pill-proj');
const pillNext  = document.getElementById('pill-next');
const pillThread= document.getElementById('pill-thread');
const pillRef   = document.getElementById('pill-ref');
const pillPrefs = document.getElementById('pill-prefs');
const pillSettings = document.getElementById('pill-settings');
const panel = document.getElementById('settings-panel');

let lastSettings = null;

function make(el, cls, text){ const d=document.createElement(el); if(cls) d.className=cls; if(text!=null) d.textContent=text; return d; }
function addUser(text){ const row=make('div','msg user'); row.appendChild(make('div','bubble',text)); logEl.appendChild(row); logEl.scrollTop=logEl.scrollHeight; }
function addAssistant(text){ const row=make('div','msg assistant'); row.appendChild(make('div','bubble',text)); logEl.appendChild(row); logEl.scrollTop=logEl.scrollHeight; }
function addSystem(text){ const r=make('div','system',text); logEl.appendChild(r); logEl.scrollTop=logEl.scrollHeight; }

const ws = new WebSocket(location.origin.replace(/^http/,'ws') + '/chat');

ws.addEventListener('open',  ()=> addSystem('[ws] connected'));
ws.addEventListener('close', ()=> addSystem('[ws] closed'));
ws.addEventListener('error', ()=> addSystem('[ws] error'));

ws.addEventListener('message', (ev)=>{
  let p; try{ p=JSON.parse(ev.data) }catch{ return; }
  if (p.type === 'system') addSystem(p.text);
  if (p.type === 'assistant_start') sendBtn.disabled = true;
  if (p.type === 'assistant_chunk') { /* streaming handled by final append */ }
  if (p.type === 'assistant') { addAssistant(p.text); sendBtn.disabled=false; }
  if (p.type === 'hash') {} // ignored
  if (p.type === 'mem') {}  // ignored
  if (p.type === 'settings') {
    lastSettings = p.value||{};
    const prefs = lastSettings.prefs||{};
    pillProj.textContent   = `proj:${lastSettings.active_goal || 'none'}`;
    pillNext.textContent   = `next:${lastSettings.plan_next || '—'}`;
    const th = lastSettings.thread || {};
    pillThread.textContent = `thread:${th.topic || '—'}`;
    pillRef.textContent    = `ref:${th.referent || '—'}`;
    pillPrefs.textContent  = `prefs: v${prefs.verbosity ?? '?'} t:${prefs.tone||'?'} g:${prefs.guard||'?'} syc:${prefs.syc? 'on':'off'}`;
  }
});

form.addEventListener('submit',(e)=>{
  e.preventDefault();
  const text = input.value.trim();
  if(!text || ws.readyState!==WebSocket.OPEN) return;
  ws.send(JSON.stringify({type:'user', text}));
  addUser(text);
  input.value='';
});

input.addEventListener('keydown',(e)=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); form.requestSubmit(); }
});

pillSettings.addEventListener('click', ()=>{
  panel.style.display = panel.style.display==='block' ? 'none' : 'block';
});

panel.addEventListener('click',(e)=>{
  const chip = e.target.closest('.chip[data-cmd]');
  if(!chip) return;
  const cmd = chip.getAttribute('data-cmd');
  ws.send(JSON.stringify({type:'user', text: cmd}));
  addUser(cmd);
  panel.style.display='none';
});
