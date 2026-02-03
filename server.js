const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

let host = null;
let viewer = null;

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get("role");
  ws.role = role;

  if (role === "host") {
    if (host) return ws.close();
    host = ws;
  }

  if (role === "viewer") {
    if (viewer) return ws.close();
    viewer = ws;
  }

  ws.on("message", msg => {
    const data = JSON.parse(msg);

    // signaling
    if (data.type === "offer" && viewer) viewer.send(msg);
    if (data.type === "answer" && host) host.send(msg);
    if (data.type === "ice") {
      if (ws === host && viewer) viewer.send(msg);
      if (ws === viewer && host) host.send(msg);
    }

    // chat
    if (data.type === "chat") {
      if (ws === host && viewer) viewer.send(msg);
      if (ws === viewer && host) host.send(msg);
    }
  });

  ws.on("close", () => {
    if (ws === host) host = null;
    if (ws === viewer) viewer = null;
  });
});

app.use(express.static(__dirname));
server.listen(3000, () =>
  console.log("🚀 http://localhost:3000")
);
