const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

/* =======================
   In-memory state
======================= */
const rooms = new Map();      // roomId -> { host, viewers: Map }
const userSessions = new Map(); // userId -> session info

function generateUserId() {
  return Math.random().toString(36).slice(2, 10);
}

/* =======================
   WebSocket handling
======================= */
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const username = url.searchParams.get('username') || 'Anonymous';
  const role = url.searchParams.get('role') || 'viewer';
  const isHost = role === 'host';

  if (!roomId) {
    ws.close(4001, 'Room ID required');
    return;
  }

  if (isHost && rooms.has(roomId) && rooms.get(roomId).host) {
    ws.close(4002, 'Host already exists');
    return;
  }

  const userId = generateUserId();

  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      host: null,
      viewers: new Map()
    });
  }

  const room = rooms.get(roomId);

  /* Attach metadata */
  ws.userId = userId;
  ws.roomId = roomId;
  ws.username = username;
  ws.isHost = isHost;

  /* Add user to room */
  if (isHost) {
    room.host = ws;
    console.log(`👑 Host ${userId} (${username}) joined room: ${roomId}`);

    // Notify viewers host exists
    room.viewers.forEach(v => {
      if (v.readyState === WebSocket.OPEN) {
        v.send(JSON.stringify({
          type: 'host-info',
          hostId: userId,
          hostName: username
        }));
      }
    });
  } else {
    room.viewers.set(userId, ws);
    console.log(`👁️ Viewer ${userId} (${username}) joined room: ${roomId}`);

    // Send host info to viewer
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'host-info',
        hostId: room.host.userId,
        hostName: room.host.username
      }));
    }
  }

  userSessions.set(userId, {
    ws,
    roomId,
    username,
    role,
    connectedAt: Date.now()
  });

  /* Welcome */
  ws.send(JSON.stringify({
    type: 'welcome',
    userId,
    username,
    room: roomId,
    role
  }));

  /* =======================
     Message handling
  ======================= */
  ws.on('message', message => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;
    }

    switch (data.type) {

      /* ---------- WebRTC signaling ---------- */
      case 'offer':
        forwardToTarget('offer', data, ws, room);
        break;

      case 'answer':
        forwardToTarget('answer', data, ws, room);
        break;

      case 'ice-candidate':
        forwardToTarget('ice-candidate', data, ws, room);
        break;

      /* ---------- Viewer requests screen ---------- */
      case 'screen-request':
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify({
            type: 'screen-request',
            viewerId: ws.userId,
            viewerName: ws.username
          }));
        }
        break;

      /* ---------- FIX: forward screen-sharing-started ---------- */
      case 'screen-sharing-started':
        console.log(`📨 screen-sharing-started from ${ws.userId} (host)`);

        room.viewers.forEach(v => {
          if (v.readyState === WebSocket.OPEN) {
            v.send(JSON.stringify({
              type: 'screen-sharing-started',
              hostId: ws.userId,
              hostName: ws.username,
              timestamp: Date.now()
            }));
          }
        });
        break;

      /* ---------- Health ping ---------- */
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  /* =======================
     Disconnect handling
  ======================= */
  ws.on('close', (code, reason) => {
    console.log(
      `👋 ${userId} (${username}) disconnected. Code: ${code}, Reason: ${reason || ''}`
    );

    userSessions.delete(userId);

    const room = rooms.get(roomId);
    if (!room) return;

    if (isHost) {
      room.host = null;
      console.log(`👑 Host ${userId} left room ${roomId}`);

      room.viewers.forEach(v => {
        if (v.readyState === WebSocket.OPEN) {
          v.send(JSON.stringify({ type: 'host-left' }));
        }
      });
    } else {
      room.viewers.delete(userId);

      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
          type: 'viewer-left',
          viewerId: userId
        }));
      }
    }

    if (!room.host && room.viewers.size === 0) {
      rooms.delete(roomId);
      console.log(`🗑️ Room ${roomId} deleted`);
    }
  });

  ws.on('error', err => {
    console.error('WebSocket error:', err);
  });
});

/* =======================
   Helpers
======================= */
function forwardToTarget(type, data, sender, room) {
  let targetWs = null;

  if (sender.isHost) {
    targetWs = room.viewers.get(data.target);
  } else {
    targetWs = room.host;
  }

  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({
      type,
      sender: sender.userId,
      sdp: data.sdp,
      candidate: data.candidate
    }));
  }
}

/* =======================
   HTTP endpoints
======================= */
app.get('/health', (_, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (_, res) => {
  res.json({
    service: 'SyncFlix Signaling Server',
    rooms: rooms.size,
    users: userSessions.size
  });
});

/* =======================
   Start server
======================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
