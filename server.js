const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const rooms = new Map();
const userSessions = new Map();

function generateUserId() {
  return Math.random().toString(36).substring(2, 10);
}

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
    rooms.set(roomId, { host: null, viewers: new Map() });
  }

  const room = rooms.get(roomId);

  ws.userId = userId;
  ws.roomId = roomId;
  ws.username = username;
  ws.role = role;
  ws.isHost = isHost;

  if (isHost) {
    room.host = ws;
  } else {
    room.viewers.set(userId, ws);
    if (room.host?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'host-info',
        hostId: room.host.userId,
        hostName: room.host.username
      }));
    }
  }

  userSessions.set(userId, { ws, roomId });

  ws.send(JSON.stringify({
    type: 'welcome',
    userId,
    username,
    room: roomId,
    role,
    isHost
  }));

  ws.on('message', message => {
    const data = JSON.parse(message.toString());
    switch (data.type) {
      case 'offer':
        forward('offer', data, ws, room);
        break;
      case 'answer':
        forward('answer', data, ws, room);
        break;
      case 'ice-candidate':
        forward('ice-candidate', data, ws, room);
        break;
      case 'screen-request':
        room.host?.send(JSON.stringify({
          type: 'screen-request',
          viewerId: ws.userId,
          viewerName: ws.username
        }));
        break;
    }
  });

  ws.on('close', () => {
    userSessions.delete(userId);
    if (isHost) room.host = null;
    else room.viewers.delete(userId);
    if (!room.host && room.viewers.size === 0) rooms.delete(roomId);
  });
});

function forward(type, data, sender, room) {
  const target = sender.isHost
    ? room.viewers.get(data.target)
    : room.host;

  if (target?.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify({
      type,
      sender: sender.userId,
      sdp: data.sdp,
      candidate: data.candidate
    }));
  }
}

app.get('/health', (_, res) => res.json({ status: 'ok' }));

server.listen(process.env.PORT || 3000);
