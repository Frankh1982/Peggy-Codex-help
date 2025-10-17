const logEl  = document.getElementById('log');
const form   = document.getElementById('chat');
const input  = document.getElementById('msg');
const hashEl = document.getElementById('hash');

function add(line) {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/chat');

ws.addEventListener('open',  () => add('[ws] connected'));
ws.addEventListener('close', () => add('[ws] closed'));
ws.addEventListener('error', () => add('[ws] error'));

ws.addEventListener('message', (ev) => {
  let payload;
  try { payload = JSON.parse(ev.data); } catch { payload = { type:'raw', text:String(ev.data) }; }
  if (payload.type === 'hash')     { hashEl.textContent = 'hash: ' + payload.value; return; }
  if (payload.type === 'system')   { add('[sys] ' + payload.text); return; }
  if (payload.type === 'assistant'){ add('assistant: ' + payload.text); return; }
  if (payload.type === 'raw')      { add(payload.text); return; }
  add('[unknown] ' + ev.data);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'user', text }));
  add('you: ' + text);
  input.value = '';
});
