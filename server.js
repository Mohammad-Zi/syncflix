const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  path: '/ws',
  clientTracking: true
});

// Store rooms data
const rooms = new Map();
const userSessions = new Map();

wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection');
  
  // Parse query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const username = url.searchParams.get('username') || 'Anonymous';
  const role = url.searchParams.get('role') || 'viewer'; // 'host' or 'viewer'
  const isHost = role === 'host';
  
  if (!roomId) {
    console.log('❌ No room ID provided');
    ws.close(4001, 'Room ID required');
    return;
  }
  
  // Initialize room if it doesn't exist
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      connections: new Set(),
      host: null,
      viewers: new Set()
    });
  }
  
  const room = rooms.get(roomId);
  
  // Check if host already exists
  if (isHost && room.host) {
    console.log('❌ Host already exists in room');
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Host already exists in this room',
      code: 'HOST_EXISTS'
    }));
    ws.close(4002, 'Host already exists');
    return;
  }
  
  // Add connection to room
  const userId = generateUserId();
  ws.userId = userId;
  ws.roomId = roomId;
  ws.username = username;
  ws.role = role;
  ws.isHost = isHost;
  
  room.connections.add(ws);
  
  if (isHost) {
    room.host = ws;
  } else {
    room.viewers.add(ws);
  }
  
  // Store user session
  userSessions.set(userId, {
    roomId,
    username,
    role,
    isHost,
    connectedAt: Date.now(),
    ip: req.socket.remoteAddress
  });
  
  console.log(`✅ ${userId} (${username}) joined room: ${roomId} as ${role}`);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    userId,
    username,
    room: roomId,
    role,
    isHost,
    timestamp: Date.now(),
    message: `Connected as ${role}`
  }));
  
  // If viewer joins, send host info
  if (!isHost && room.host) {
    ws.send(JSON.stringify({
      type: 'host-info',
      hostId: room.host.userId,
      hostName: room.host.username,
      timestamp: Date.now()
    }));
    
    // Notify host about new viewer
    if (room.host.readyState === WebSocket.OPEN) {
      room.host.send(JSON.stringify({
        type: 'viewer-joined',
        viewerId: userId,
        viewerName: username,
        timestamp: Date.now()
      }));
    }
  }
  
  // If host joins, notify all viewers
  if (isHost && room.viewers.size > 0) {
    const viewers = Array.from(room.viewers).map(v => ({
      id: v.userId,
      name: v.username
    }));
    
    ws.send(JSON.stringify({
      type: 'viewers-list',
      viewers,
      timestamp: Date.now()
    }));
    
    // Notify all viewers about host
    room.viewers.forEach(viewer => {
      if (viewer.readyState === WebSocket.OPEN) {
        viewer.send(JSON.stringify({
          type: 'host-joined',
          hostId: userId,
          hostName: username,
          timestamp: Date.now()
        }));
      }
    });
  }
  
  // Handle messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📨 ${data.type} from ${userId} (${role})`);
      
      switch(data.type) {
        case 'offer':
          handleOffer(data, ws, room);
          break;
          
        case 'answer':
          handleAnswer(data, ws, room);
          break;
          
        case 'ice-candidate':
          handleIceCandidate(data, ws, room);
          break;
          
        case 'screen-sharing-started':
          // Host started sharing, notify all viewers
          broadcastToViewers(room, ws, {
            type: 'screen-sharing-started',
            hostId: userId,
            hostName: username,
            timestamp: Date.now()
          });
          break;
          
        case 'screen-sharing-stopped':
          // Host stopped sharing, notify all viewers
          broadcastToViewers(room, ws, {
            type: 'screen-sharing-stopped',
            hostId: userId,
            timestamp: Date.now()
          });
          break;
          
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
          break;
          
        case 'get-room-info':
          sendRoomInfo(ws, room);
          break;
          
        case 'request-screen':
          // Viewer requests screen from host
          if (!isHost && room.host) {
            room.host.send(JSON.stringify({
              type: 'screen-request',
              viewerId: userId,
              viewerName: username,
              timestamp: Date.now()
            }));
          }
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });
  
  // Handle disconnect
  ws.on('close', () => {
    console.log(`👋 ${userId} (${role}) disconnected`);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.connections.delete(ws);
      
      if (isHost) {
        room.host = null;
        // Notify all viewers that host left
        broadcastToViewers(room, null, {
          type: 'host-left',
          timestamp: Date.now()
        });
      } else {
        room.viewers.delete(ws);
        // Notify host that viewer left
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify({
            type: 'viewer-left',
            viewerId: userId,
            timestamp: Date.now()
          }));
        }
      }
      
      // Clean up empty room
      if (room.connections.size === 0) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted`);
      }
    }
    
    userSessions.delete(userId);
  });
  
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${userId}:`, error);
  });
});

// Helper functions
function generateUserId() {
  return Math.random().toString(36).substring(2, 9);
}

function handleOffer(data, sender, room) {
  const { target, sdp } = data;
  
  // Find target connection
  let targetWs = null;
  room.connections.forEach(client => {
    if (client.userId === target && client.readyState === WebSocket.OPEN) {
      targetWs = client;
    }
  });
  
  if (targetWs) {
    targetWs.send(JSON.stringify({
      type: 'offer',
      sender: sender.userId,
      senderName: sender.username,
      sdp,
      timestamp: Date.now()
    }));
    console.log(`📤 Forwarded offer from ${sender.userId} to ${target}`);
  }
}

function handleAnswer(data, sender, room) {
  const { target, sdp } = data;
  
  let targetWs = null;
  room.connections.forEach(client => {
    if (client.userId === target && client.readyState === WebSocket.OPEN) {
      targetWs = client;
    }
  });
  
  if (targetWs) {
    targetWs.send(JSON.stringify({
      type: 'answer',
      sender: sender.userId,
      sdp,
      timestamp: Date.now()
    }));
  }
}

function handleIceCandidate(data, sender, room) {
  const { target, candidate } = data;
  
  let targetWs = null;
  room.connections.forEach(client => {
    if (client.userId === target && client.readyState === WebSocket.OPEN) {
      targetWs = client;
    }
  });
  
  if (targetWs) {
    targetWs.send(JSON.stringify({
      type: 'ice-candidate',
      sender: sender.userId,
      candidate,
      timestamp: Date.now()
    }));
  }
}

function broadcastToViewers(room, sender, message) {
  const messageStr = JSON.stringify(message);
  room.viewers.forEach(viewer => {
    if (viewer !== sender && viewer.readyState === WebSocket.OPEN) {
      viewer.send(messageStr);
    }
  });
}

function sendRoomInfo(ws, room) {
  const viewers = Array.from(room.viewers).map(v => ({
    id: v.userId,
    name: v.username
  }));
  
  ws.send(JSON.stringify({
    type: 'room-info',
    host: room.host ? {
      id: room.host.userId,
      name: room.host.username
    } : null,
    viewers,
    viewerCount: viewers.length,
    timestamp: Date.now()
  }));
}

// HTTP routes
app.get('/', (req, res) => {
  const roomsInfo = [];
  rooms.forEach((room, roomId) => {
    roomsInfo.push({
      roomId,
      host: room.host ? room.host.username : null,
      viewerCount: room.viewers.size,
      connections: room.connections.size
    });
  });
  
  res.json({
    service: 'SyncFlix Screen Sharing Server',
    status: 'online',
    rooms: roomsInfo,
    totalRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/room/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    res.json({
      roomId,
      host: room.host ? {
        id: room.host.userId,
        name: room.host.username
      } : null,
      viewers: Array.from(room.viewers).map(v => ({
        id: v.userId,
        name: v.username
      })),
      viewerCount: room.viewers.size
    });
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

app.post('/room/create', (req, res) => {
  const { roomId, username } = req.body;
  
  if (!roomId) {
    return res.status(400).json({ error: 'Room ID required' });
  }
  
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers.host;
  
  res.json({
    success: true,
    roomId,
    hostUrl: `${protocol === 'https' ? 'wss' : 'ws'}://${host}/ws?room=${roomId}&username=${username || 'Host'}&role=host`,
    viewerUrl: `${protocol === 'https' ? 'wss' : 'ws'}://${host}/ws?room=${roomId}&username=Viewer&role=viewer`,
    message: 'Room created'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`🌐 HTTP API available at http://localhost:${PORT}`);
});