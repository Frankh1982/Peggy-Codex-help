const logEl  = document.getElementById('log');
const form   = document.getElementById('chat');
const input  = document.getElementById('msg');
const sendBtn= document.getElementById('send');
const hashEl = document.getElementById('hash');

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

  if (payload.type === 'hash')     { hashEl.textContent = 'hash: ' + payload.value; return; }
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
