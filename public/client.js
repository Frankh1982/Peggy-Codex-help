const logEl  = document.getElementById('log');
const form   = document.getElementById('chat');
const input  = document.getElementById('msg');
const sendBtn= document.getElementById('send');
const hashEl = document.getElementById('hash');
const hudEl  = document.getElementById('hud');
const memEl  = document.getElementById('mem');
const projEl = document.getElementById('proj');
const planEl = document.getElementById('plan');
const threadEl = document.getElementById('thread');
const refEl = document.getElementById('ref');
const settingsEl = document.getElementById('settings');
let lastSettings = null;

const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/chat');

function scrollBottom(){ logEl.scrollTop = logEl.scrollHeight; }
function make(el, cls, text){ const d=document.createElement(el); if(cls) d.className=cls; if(text!=null) d.textContent=text; return d; }
function addUser(text){
  const row = make('div','msg user');
  row.appendChild(make('div','bubble', text));
  logEl.appendChild(row); scrollBottom();
}
let typingRow = null;
function startTyping(){
  stopTyping();
  typingRow = make('div','msg assistant');
  typingRow.appendChild(make('div','bubble typing','…'));
  logEl.appendChild(typingRow); scrollBottom();
}
function appendAssistantChunk(chunk){
  if(!typingRow) startTyping();
  const b = typingRow.querySelector('.bubble');
  b.classList.remove('typing');
  b.textContent += chunk;
  scrollBottom();
}
function stopTyping(finalText){
  if(!typingRow) return;
  const b = typingRow.querySelector('.bubble');
  if(finalText!=null) b.textContent = finalText;
  typingRow = null; scrollBottom();
}

ws.addEventListener('open',  () => {
  const r = make('div','system','[ws] connected'); logEl.appendChild(r); scrollBottom();
});
ws.addEventListener('close', () => {
  const r = make('div','system','[ws] closed'); logEl.appendChild(r); scrollBottom();
});
ws.addEventListener('error', () => {
  const r = make('div','system','[ws] error'); logEl.appendChild(r); scrollBottom();
});

ws.addEventListener('message', (ev) => {
  let payload;
  try { payload = JSON.parse(ev.data); } catch { payload = { type:'raw', text:String(ev.data) }; }

  if (payload.type === 'hash')     {
    if (hashEl) {
      hashEl.dataset.run = payload.value;
      hashEl.textContent = `run: ${payload.value}`;
      hashEl.title = `run: ${payload.value}`;
    }
    return;
  }
  if (payload.type === 'mem')      { memEl.textContent  = 'mem: '  + payload.rev; return; }
  if (payload.type === 'settings') {
    const value = payload.value || {};
    lastSettings = value;
    const prefs = value.prefs || {};
    const slug = value.active_goal || 'none';
    const next = Number(value.plan_next || 0);
    const topic = value.thread?.topic && value.thread.topic.trim() ? value.thread.topic.trim() : '—';
    const referent = value.thread?.referent && value.thread.referent.trim() ? value.thread.referent.trim() : '—';

    if (hudEl) {
      const pills = [
        `proj:${slug}`,
        `next:${next > 0 ? `#${next}` : '—'}`,
        `thread:${topic}`,
        `ref:${referent}`,
        `prefs:v${prefs.verbosity ?? '?'} t:${prefs.tone || '?'} g:${prefs.guard || '?'} syc:${prefs.syc ? 'on' : 'off'}`,
      ].join('  ');
      hudEl.textContent = pills;
    }

    if (settingsEl) {
      settingsEl.textContent = `prefs: v${prefs.verbosity ?? '?'} t:${prefs.tone || '?'} g:${prefs.guard || '?'} syc:${prefs.syc ? 'on' : 'off'}`;
      try { settingsEl.title = JSON.stringify(value, null, 2); } catch { settingsEl.title = ''; }
    }

    if (projEl) {
      projEl.textContent = `proj: ${slug || 'none'}`;
    }

    if (planEl) {
      planEl.textContent = next > 0 ? `next: #${next}` : 'next: —';
      if (value.plan_hash) {
        planEl.dataset.hash = value.plan_hash;
      } else {
        delete planEl.dataset.hash;
      }
    }

    if (threadEl) {
      threadEl.textContent = `thread: ${topic}`;
    }

    if (refEl) {
      refEl.textContent = `ref: ${referent}`;
    }

    return;
  }
  if (payload.type === 'system')   { const r=make('div','system',payload.text); logEl.appendChild(r); scrollBottom(); return; }

  if (payload.type === 'assistant_start'){ sendBtn.disabled=true; startTyping(); return; }
  if (payload.type === 'assistant_chunk'){ appendAssistantChunk(payload.text || ''); return; }
  if (payload.type === 'assistant')      { stopTyping(payload.text || ''); sendBtn.disabled=false; return; }

  if (payload.type === 'raw') { const r=make('div','system',payload.text); logEl.appendChild(r); scrollBottom(); }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;
  addUser(text);
  sendBtn.disabled = true;
  ws.send(JSON.stringify({ type: 'user', text }));
  input.value = '';
});

// Enter to send, Shift+Enter to newline
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// --- Settings drawer ---
const pill = document.getElementById('settings-pill');
const panel = document.getElementById('settings-panel');
const sval = (id, v) => {
  const el = document.getElementById(id);
  if (el) el.textContent = String(v ?? '');
};

if (pill && panel) {
  panel.style.display = panel.style.display || 'none';
  pill.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    const cmd = btn.getAttribute('data-cmd');
    // Translate cycle/toggle shortcuts into concrete commands
    let toSend = cmd;
    if (cmd === 'set verbosity to cycle') {
      const v = (lastSettings?.prefs?.verbosity ?? 1);
      toSend = `set verbosity to ${((v + 1) % 4)}`;
    } else if (cmd === 'set tone to cycle') {
      const order = ['direct', 'neutral', 'friendly'];
      const cur = lastSettings?.prefs?.tone ?? 'direct';
      const nextTone = order[(order.indexOf(cur) + 1) % order.length];
      toSend = `set tone to ${nextTone}`;
    } else if (cmd === 'set guard to toggle') {
      const cur = lastSettings?.prefs?.guard ?? 'strict';
      toSend = `set guard to ${cur === 'strict' ? 'normal' : 'strict'}`;
    } else if (cmd === 'chatty toggle') {
      const cur = lastSettings?.prefs?.chatty ?? 0;
      toSend = `chatty ${cur ? 'off' : 'on'}`;
    }
    // Send as a normal chat message (keeps one protocol path)
    ws.send(JSON.stringify({ type: 'user', text: toSend }));
    addUser(toSend);
  });
}

ws.addEventListener('message', (ev) => {
  let p;
  try {
    p = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (p.type === 'settings') {
    lastSettings = p.value || {};
    sval('s-verbosity', lastSettings?.prefs?.verbosity);
    sval('s-syc', lastSettings?.prefs?.syc ? 'on' : 'off');
    sval('s-tone', lastSettings?.prefs?.tone);
    sval('s-guard', lastSettings?.prefs?.guard);
    sval('s-chatty', lastSettings?.prefs?.chatty ? 'on' : 'off');
  }
});
