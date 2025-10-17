const log = document.getElementById("log");
const form = document.getElementById("f");
const input = document.getElementById("t");
const ws = new WebSocket(`ws://${location.host}/chat`);

function add(line){ log.textContent += line + "\\n"; log.scrollTop = log.scrollHeight; }

ws.onopen = ()=>add("[ws] connected");
ws.onmessage = (ev)=>add(ev.data);
ws.onclose = ()=>add("[ws] closed");
ws.onerror = (e)=>add("[ws] error");

form.addEventListener("submit", (e)=>{
  e.preventDefault();
  const msg = input.value.trim();
  if(!msg) return;
  ws.send(msg);
  add("you: " + msg);
  input.value = "";
});
