[file name]: server.js
[file content begin]
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

// Store rooms data with WebRTC session info
const rooms = new Map();

// Store user metadata
const userSessions = new Map();

wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection');
  
  // Parse query parameters from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const username = url.searchParams.get('username') || 'Anonymous';
  const isHost = url.searchParams.get('host') === 'true';
  
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
  
  // Generate unique user ID
  const userId = Math.random().toString(36).substring(7);
  
  // Store user info on WebSocket object
  ws.roomId = roomId;
  ws.userId = userId;
  ws.username = username;
  ws.isHost = isHost;
  
  // Store user session
  userSessions.set(userId, {
    roomId,
    username,
    isHost,
    connectedAt: Date.now()
  });
  
  console.log(`✅ ${userId} (${username}) joined room: ${roomId}${isHost ? ' [HOST]' : ''}`);
  
  // Send welcome message with user info
  ws.send(JSON.stringify({
    type: 'welcome',
    userId: userId,
    username: username,
    room: roomId,
    isHost: isHost,
    message: 'Connected to SyncFlix WebRTC signaling server'
  }));
  
  // Get existing users in room (excluding self)
  const existingUsers = getUsersInRoom(roomId).filter(user => user.id !== userId);
  
  // Send existing users to new connection
  if (existingUsers.length > 0) {
    ws.send(JSON.stringify({
      type: 'existing-users',
      users: existingUsers
    }));
  }
  
  // Notify others in room about new user
  broadcastToRoom(roomId, ws, {
    type: 'user-joined',
    userId: userId,
    username: username,
    isHost: isHost
  });
  
  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📨 ${data.type} from ${userId} to ${data.target || 'all'}`);
      
      // Route messages by type
      switch (data.type) {
        // Video control messages
        case 'play':
        case 'pause':
        case 'seek':
        case 'video-change':
        case 'message':
          // Forward to all other users in room
          broadcastToRoom(roomId, ws, {
            ...data,
            senderId: userId,
            sender: username
          });
          break;
          
        // WebRTC signaling messages
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          // Forward to specific target user
          if (data.target) {
            sendToUser(data.target, {
              ...data,
              sender: userId
            });
          }
          break;
          
        case 'sync-request':
          // Send current room state back to requester
          ws.send(JSON.stringify({
            type: 'sync-response',
            room: roomId,
            users: getUsersInRoom(roomId),
            host: getHostInRoom(roomId),
            timestamp: Date.now()
          }));
          break;
          
        case 'host-change':
          // Update host status and notify all
          if (ws.isHost) {
            const newHostId = data.newHostId;
            updateHost(roomId, newHostId);
            
            broadcastToRoom(roomId, null, {
              type: 'host-changed',
              newHostId: newHostId,
              previousHostId: userId
            });
          }
          break;
          
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
          
        case 'get-users':
          ws.send(JSON.stringify({
            type: 'users-list',
            users: getUsersInRoom(roomId)
          }));
          break;
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error);
    }
  });
  
  // Handle connection close
  ws.on('close', () => {
    console.log(`👋 ${userId} disconnected`);
    
    // Remove from user sessions
    userSessions.delete(userId);
    
    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(ws);
      
      // Notify others
      broadcastToRoom(roomId, null, {
        type: 'user-left',
        userId: userId,
        username: username
      });
      
      // If host left, assign new host
      if (ws.isHost) {
        const remainingUsers = Array.from(rooms.get(roomId));
        if (remainingUsers.length > 0) {
          const newHost = remainingUsers[0];
          newHost.isHost = true;
          userSessions.get(newHost.userId).isHost = true;
          
          broadcastToRoom(roomId, null, {
            type: 'host-changed',
            newHostId: newHost.userId,
            previousHostId: userId
          });
        }
      }
      
      // Clean up empty rooms
      if (rooms.get(roomId).size === 0) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted (empty)`);
      }
    }
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${userId}:`, error);
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

// Helper function to send message to specific user
function sendToUser(userId, message) {
  // Find the user's WebSocket connection
  let targetWs = null;
  rooms.forEach(clients => {
    clients.forEach(client => {
      if (client.userId === userId && client.readyState === WebSocket.OPEN) {
        targetWs = client;
      }
    });
  });
  
  if (targetWs) {
    targetWs.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// Helper function to get users in room
function getUsersInRoom(roomId) {
  if (!rooms.has(roomId)) return [];
  
  const users = [];
  rooms.get(roomId).forEach(client => {
    users.push({
      id: client.userId,
      username: client.username,
      isHost: client.isHost
    });
  });
  return users;
}

// Helper function to get host in room
function getHostInRoom(roomId) {
  if (!rooms.has(roomId)) return null;
  
  for (const client of rooms.get(roomId)) {
    if (client.isHost) {
      return {
        id: client.userId,
        username: client.username
      };
    }
  }
  return null;
}

// Helper function to update host
function updateHost(roomId, newHostId) {
  if (!rooms.has(roomId)) return false;
  
  let success = false;
  rooms.get(roomId).forEach(client => {
    if (client.userId === newHostId) {
      client.isHost = true;
      userSessions.get(newHostId).isHost = true;
      success = true;
    } else if (client.isHost) {
      client.isHost = false;
      userSessions.get(client.userId).isHost = false;
    }
  });
  
  return success;
}

// HTTP routes
app.get('/', (req, res) => {
  res.json({
    service: 'SyncFlix WebRTC Signaling Server',
    status: 'online',
    version: '1.0.0',
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
      host: getHostInRoom(roomId),
      users: getUsersInRoom(roomId)
    });
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

app.get('/rooms', (req, res) => {
  const roomsInfo = [];
  rooms.forEach((clients, roomId) => {
    roomsInfo.push({
      room: roomId,
      userCount: clients.size,
      host: getHostInRoom(roomId)
    });
  });
  
  res.json({
    rooms: roomsInfo,
    totalRooms: rooms.size
  });
});

app.post('/room/create', (req, res) => {
  const { roomId, username } = req.body;
  
  if (!roomId) {
    return res.status(400).json({ error: 'Room ID required' });
  }
  
  if (rooms.has(roomId)) {
    return res.status(409).json({ error: 'Room already exists' });
  }
  
  res.json({
    room: roomId,
    message: 'Room created (will be active when first user joins)',
    wsUrl: `ws://${req.headers.host}/ws?room=${roomId}&username=${username || 'Host'}&host=true`
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`🌐 HTTP API available at http://localhost:${PORT}`);
});
[file content end]