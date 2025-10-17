import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/chat" });

wss.on("connection", (ws) => {
  ws.send("assistant: ready. (minimal ws echo server)");
  ws.on("message", (buf) => {
    const text = buf.toString();
    // For now, echo + a stubbed reply. We’ll swap this with OpenAI/Brave later.
    ws.send("assistant: you said -> " + text);
  });
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
