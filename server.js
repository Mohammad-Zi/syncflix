const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

let host = null;
let viewer = null;

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get("role");

  ws.role = role;

  if (role === "host") {
    if (host) {
      ws.close(4001, "Host already connected");
      return;
    }
    host = ws;
    console.log("👑 Host connected");
  }

  if (role === "viewer") {
    if (viewer) {
      ws.close(4002, "Viewer already connected");
      return;
    }
    viewer = ws;
    console.log("👁️ Viewer connected");
  }

  ws.on("message", msg => {
    const data = JSON.parse(msg);

    // Forward signaling messages
    if (data.type === "offer" && viewer) viewer.send(msg);
    if (data.type === "answer" && host) host.send(msg);
    if (data.type === "ice-candidate") {
      if (ws === host && viewer) viewer.send(msg);
      if (ws === viewer && host) host.send(msg);
    }
  });

  ws.on("close", () => {
    if (ws === host) {
      host = null;
      if (viewer) viewer.send(JSON.stringify({ type: "host-left" }));
      console.log("❌ Host disconnected");
    }
    if (ws === viewer) {
      viewer = null;
      if (host) host.send(JSON.stringify({ type: "viewer-left" }));
      console.log("❌ Viewer disconnected");
    }
  });
});

app.get("/", (_, res) => {
  res.json({ status: "ok", host: !!host, viewer: !!viewer });
});

server.listen(3000, () =>
  console.log("🚀 Server running on http://localhost:3000")
);
