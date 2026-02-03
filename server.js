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
  path: '/ws',  // IMPORTANT: Add this path
  clientTracking: true
});

// Store rooms data
const rooms = new Map();

wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection');
  
  // Parse query parameters from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const username = url.searchParams.get('username') || 'Anonymous';
  
  if (!roomId) {
    console.log('❌ No room ID provided');
    ws.close(4001, 'Room ID required');
    return;
  }
  
  // Add connection to room
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  rooms.get(roomId).add(ws);
  
  // Store user info on WebSocket object
  ws.roomId = roomId;
  ws.userId = Math.random().toString(36).substring(7);
  ws.username = username;
  
  console.log(`✅ ${ws.userId} joined room: ${roomId}`);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    userId: ws.userId,
    room: roomId,
    message: 'Connected to SyncFlix signaling server'
  }));
  
  // Notify others in room
  broadcastToRoom(roomId, ws, {
    type: 'user-joined',
    userId: ws.userId,
    username: username
  });
  
  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📨 Message from ${ws.userId}:`, data.type);
      
      // Route messages by type
      switch (data.type) {
        case 'play':
        case 'pause':
        case 'seek':
        case 'video-change':
        case 'message':
          // Forward to all other users in room
          broadcastToRoom(roomId, ws, {
            ...data,
            senderId: ws.userId,
            sender: username
          });
          break;
          
        case 'sync-request':
          // Send current room state back to requester
          ws.send(JSON.stringify({
            type: 'sync-response',
            room: roomId,
            users: getUsersInRoom(roomId),
            timestamp: Date.now()
          }));
          break;
          
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error);
    }
  });
  
  // Handle connection close
  ws.on('close', () => {
    console.log(`👋 ${ws.userId} disconnected`);
    
    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(ws);
      
      // Notify others
      broadcastToRoom(roomId, null, {
        type: 'user-left',
        userId: ws.userId,
        username: username
      });
      
      // Clean up empty rooms
      if (rooms.get(roomId).size === 0) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted (empty)`);
      }
    }
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${ws.userId}:`, error);
  });
});

// Helper function to broadcast to room (excluding sender)
function broadcastToRoom(roomId, senderWs, message) {
  if (!rooms.has(roomId)) return;
  
  const messageStr = JSON.stringify(message);
  rooms.get(roomId).forEach(client => {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

// Helper function to get users in room
function getUsersInRoom(roomId) {
  if (!rooms.has(roomId)) return [];
  
  const users = [];
  rooms.get(roomId).forEach(client => {
    users.push({
      id: client.userId,
      username: client.username
    });
  });
  return users;
}

// HTTP routes for health checks
app.get('/', (req, res) => {
  res.json({
    service: 'SyncFlix Signaling Server',
    status: 'online',
    activeRooms: rooms.size,
    totalConnections: Array.from(rooms.values())
      .reduce((sum, clients) => sum + clients.size, 0),
    timestamp: new Date().toISOString()
  });
});

app.get('/room/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  if (rooms.has(roomId)) {
    res.json({
      room: roomId,
      userCount: rooms.get(roomId).size,
      users: getUsersInRoom(roomId)
    });
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`🌐 HTTP API available at http://localhost:${PORT}`);
});