const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = url.searchParams.get("room");
  const role = url.searchParams.get("role");

  if (!room) return ws.close();

  if (!rooms.has(room)) {
    rooms.set(room, { host: null, viewers: new Map() });
  }

  const roomData = rooms.get(room);
  ws.id = uid();
  ws.role = role;
  ws.room = room;

  if (role === "host") {
    roomData.host = ws;
  } else {
    roomData.viewers.set(ws.id, ws);
  }

  ws.on("message", msg => {
    const data = JSON.parse(msg);

    // chat
    if (data.type === "chat") {
      broadcast(roomData, {
        type: "chat",
        sender: ws.role,
        message: data.message
      });
    }

    // WebRTC signaling
    if (["offer", "answer", "ice"].includes(data.type)) {
      const target =
        ws.role === "host"
          ? roomData.viewers.get(data.target)
          : roomData.host;

      if (target?.readyState === 1) {
        target.send(JSON.stringify({
          type: data.type,
          payload: data.payload,
          sender: ws.id
        }));
      }
    }

    // screen started
    if (data.type === "screen-started") {
      broadcast(roomData, { type: "screen-started" });
    }
  });

  ws.on("close", () => {
    if (ws.role === "host") roomData.host = null;
    else roomData.viewers.delete(ws.id);
  });
});

function broadcast(room, msg) {
  if (room.host?.readyState === 1)
    room.host.send(JSON.stringify(msg));
  room.viewers.forEach(v =>
    v.readyState === 1 && v.send(JSON.stringify(msg))
  );
}

server.listen(process.env.PORT || 3000);
