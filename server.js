const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    const data = JSON.parse(message);

    const room = rooms.get(data.room);
    if (!room && data.type !== "join") return;

    switch (data.type) {
      case "join": {
        if (!rooms.has(data.room)) {
          rooms.set(data.room, { host: ws, viewer: null });
        } else {
          rooms.get(data.room).viewer = ws;
        }
        ws.room = data.room;
        break;
      }

      case "offer":
      case "answer":
      case "ice-candidate":
      case "screen-request":
        if (ws === room.host && room.viewer) {
          room.viewer.send(JSON.stringify(data));
        } else if (ws === room.viewer && room.host) {
          room.host.send(JSON.stringify(data));
        }
        break;

      case "chat":
        if (room.host && ws !== room.host) room.host.send(JSON.stringify(data));
        if (room.viewer && ws !== room.viewer) room.viewer.send(JSON.stringify(data));
        break;
    }
  });

  ws.on("close", () => {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;

    if (room.host === ws) room.host = null;
    if (room.viewer === ws) room.viewer = null;
  });
});

server.listen(3000, () =>
  console.log("🚀 Server running on http://localhost:3000")
);
