const transcript = document.getElementById('transcript');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const badge = document.getElementById('capsule-hash');

let ws;
let pendingAssistant;
let sourcesList;

function ensureSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chat`);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', () => {
    setTimeout(ensureSocket, 2000);
  });
}

function addBubble(role, text = '') {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  transcript.appendChild(bubble);
  transcript.scrollTop = transcript.scrollHeight;
  return bubble;
}

function onMessage(event) {
  const data = JSON.parse(event.data);
  switch (data.type) {
    case 'init':
      badge.textContent = `hash: ${data.capsuleHash || '--'}`;
      break;
    case 'chunk':
      if (!pendingAssistant) {
        pendingAssistant = addBubble('assistant');
      }
      pendingAssistant.textContent += data.text;
      transcript.scrollTop = transcript.scrollHeight;
      break;
    case 'done':
      badge.textContent = `hash: ${data.capsuleHash || '--'}`;
      if (data.sources && data.sources.length) {
        if (!sourcesList) {
          sourcesList = document.createElement('div');
          sourcesList.className = 'sources';
          pendingAssistant?.appendChild(sourcesList);
        }
        sourcesList.innerHTML =
          '<strong>Sources:</strong> ' +
          data.sources
            .map((url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
            .join(', ');
      }
      pendingAssistant = null;
      sourcesList = null;
      break;
    case 'error':
      addBubble('assistant', `Error: ${data.message}`);
      pendingAssistant = null;
      break;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  addBubble('user', text);
  ws.send(JSON.stringify({ text }));
  input.value = '';
  input.focus();
  pendingAssistant = addBubble('assistant');
});

ensureSocket();
