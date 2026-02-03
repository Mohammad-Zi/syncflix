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

// Helper function to generate unique user ID
function generateUserId() {
  return Math.random().toString(36).substring(2, 9);
}

// Helper function to get room info
function getRoomInfo(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  
  return {
    roomId,
    host: room.host ? {
      id: room.host.userId,
      name: room.host.username
    } : null,
    viewers: Array.from(room.viewers.values()).map(ws => ({
      id: ws.userId,
      name: ws.username
    })),
    viewerCount: room.viewers.size
  };
}

// Helper function to send message to specific user
function sendToUser(userId, message) {
  const session = userSessions.get(userId);
  if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  
  try {
    session.ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error(`Error sending message to ${userId}:`, error);
    return false;
  }
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection');
  
  // Parse query parameters from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const username = url.searchParams.get('username') || 'Anonymous';
  const role = url.searchParams.get('role') || 'viewer';
  const isHost = role === 'host';
  
  // Validate required parameters
  if (!roomId) {
    console.log('❌ No room ID provided');
    ws.close(4001, 'Room ID required');
    return;
  }
  
  // Check if host already exists in room
  if (isHost && rooms.has(roomId) && rooms.get(roomId).host) {
    console.log(`❌ Host already exists in room ${roomId}`);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Host already exists in this room',
      code: 'HOST_EXISTS'
    }));
    ws.close(4002, 'Host already exists');
    return;
  }
  
  // Generate unique user ID
  const userId = generateUserId();
  
  // Initialize room if it doesn't exist
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      host: null,
      viewers: new Map()
    });
  }
  
  const room = rooms.get(roomId);
  
  // Store connection info
  ws.userId = userId;
  ws.roomId = roomId;
  ws.username = username;
  ws.role = role;
  ws.isHost = isHost;
  
  // Add to room
  if (isHost) {
    room.host = ws;
    console.log(`👑 Host ${userId} (${username}) joined room: ${roomId}`);
    
    // Notify existing viewers about new host
    room.viewers.forEach(viewerWs => {
      if (viewerWs.readyState === WebSocket.OPEN) {
        viewerWs.send(JSON.stringify({
          type: 'host-joined',
          hostId: userId,
          hostName: username,
          timestamp: Date.now()
        }));
      }
    });
  } else {
    room.viewers.set(userId, ws);
    console.log(`👁️ Viewer ${userId} (${username}) joined room: ${roomId}`);
    
    // Send host info to new viewer
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'host-info',
        hostId: room.host.userId,
        hostName: room.host.username,
        timestamp: Date.now()
      }));
    }
  }
  
  // Store user session
  userSessions.set(userId, {
    ws,
    roomId,
    username,
    role,
    isHost,
    connectedAt: Date.now(),
    ip: req.socket.remoteAddress
  });
  
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
  
  // If host joined and there are viewers, send viewers list to host
  if (isHost && room.viewers.size > 0) {
    const viewers = Array.from(room.viewers.values()).map(v => ({
      id: v.userId,
      name: v.username
    }));
    
    ws.send(JSON.stringify({
      type: 'viewers-list',
      viewers,
      timestamp: Date.now()
    }));
  }
  
  // Handle incoming messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📨 ${data.type} from ${userId} (${role})`);
      
      switch (data.type) {
        // WebRTC signaling messages
        case 'offer':
          handleOffer(data, ws, room);
          break;
          
        case 'answer':
          handleAnswer(data, ws, room);
          break;
          
        case 'ice-candidate':
          handleIceCandidate(data, ws, room);
          break;
          
        // Screen sharing notifications
        case 'screen-sharing-started':
          if (isHost) {
            // Notify all viewers that host started sharing
            room.viewers.forEach(viewerWs => {
              if (viewerWs.readyState === WebSocket.OPEN) {
                viewerWs.send(JSON.stringify({
                  type: 'screen-sharing-started',
                  hostId: userId,
                  hostName: username,
                  timestamp: Date.now()
                }));
              }
            });
          }
          break;
          
        case 'screen-sharing-stopped':
          if (isHost) {
            // Notify all viewers that host stopped sharing
            room.viewers.forEach(viewerWs => {
              if (viewerWs.readyState === WebSocket.OPEN) {
                viewerWs.send(JSON.stringify({
                  type: 'screen-sharing-stopped',
                  hostId: userId,
                  timestamp: Date.now()
                }));
              }
            });
          }
          break;
          
        // Screen request from viewer
        case 'request-screen':
          if (!isHost && room.host && room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({
              type: 'screen-request',
              viewerId: userId,
              viewerName: username,
              timestamp: Date.now()
            }));
          }
          break;
          
        // Ping/pong for connection health
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
          break;
          
        // Room info request
        case 'get-room-info':
          ws.send(JSON.stringify({
            type: 'room-info',
            room: roomId,
            host: room.host ? {
              id: room.host.userId,
              name: room.host.username
            } : null,
            viewers: Array.from(room.viewers.values()).map(v => ({
              id: v.userId,
              name: v.username
            })),
            viewerCount: room.viewers.size,
            timestamp: Date.now()
          }));
          break;
          
        default:
          console.log(`⚠️ Unknown message type from ${userId}: ${data.type}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown message type: ${data.type}`,
            timestamp: Date.now()
          }));
      }
    } catch (error) {
      console.error(`❌ Error parsing message from ${userId}:`, error);
      console.error('Raw message:', message.toString());
      
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid JSON message',
        timestamp: Date.now()
      }));
    }
  });
  
  // Handle connection close
  ws.on('close', (code, reason) => {
    console.log(`👋 ${userId} (${username}) disconnected. Code: ${code}, Reason: ${reason || 'No reason'}`);
    
    // Remove from user sessions
    userSessions.delete(userId);
    
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (isHost) {
      // Host disconnected
      room.host = null;
      console.log(`👑 Host ${userId} left room ${roomId}`);
      
      // Notify all viewers
      room.viewers.forEach(viewerWs => {
        if (viewerWs.readyState === WebSocket.OPEN) {
          viewerWs.send(JSON.stringify({
            type: 'host-left',
            timestamp: Date.now()
          }));
        }
      });
    } else {
      // Viewer disconnected
      room.viewers.delete(userId);
      console.log(`👁️ Viewer ${userId} left room ${roomId}`);
      
      // Notify host
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
          type: 'viewer-left',
          viewerId: userId,
          timestamp: Date.now()
        }));
      }
    }
    
    // Clean up empty room
    if (!room.host && room.viewers.size === 0) {
      rooms.delete(roomId);
      console.log(`🗑️ Room ${roomId} deleted (empty)`);
    }
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${userId}:`, error);
  });
});

// Handle WebRTC offer messages
function handleOffer(data, sender, room) {
  const { target, sdp } = data;
  
  if (!target || !sdp) {
    console.log('❌ Invalid offer: missing target or sdp');
    return;
  }
  
  let targetWs = null;
  
  if (sender.isHost) {
    // Host sending offer to viewer
    targetWs = room.viewers.get(target);
  } else {
    // Viewer sending offer to host
    if (room.host && room.host.userId === target) {
      targetWs = room.host;
    }
  }
  
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({
      type: 'offer',
      sender: sender.userId,
      senderName: sender.username,
      sdp: sdp,
      timestamp: Date.now()
    }));
    console.log(`📤 Forwarded offer from ${sender.userId} to ${target}`);
  } else {
    console.log(`❌ Target ${target} not found or not connected`);
  }
}

// Handle WebRTC answer messages
function handleAnswer(data, sender, room) {
  const { target, sdp } = data;
  
  if (!target || !sdp) {
    console.log('❌ Invalid answer: missing target or sdp');
    return;
  }
  
  let targetWs = null;
  
  if (sender.isHost) {
    // Host sending answer to viewer
    targetWs = room.viewers.get(target);
  } else {
    // Viewer sending answer to host
    if (room.host && room.host.userId === target) {
      targetWs = room.host;
    }
  }
  
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({
      type: 'answer',
      sender: sender.userId,
      sdp: sdp,
      timestamp: Date.now()
    }));
    console.log(`📤 Forwarded answer from ${sender.userId} to ${target}`);
  } else {
    console.log(`❌ Target ${target} not found or not connected`);
  }
}

// Handle ICE candidate messages
function handleIceCandidate(data, sender, room) {
  const { target, candidate } = data;
  
  if (!target || !candidate) {
    console.log('❌ Invalid ICE candidate: missing target or candidate');
    return;
  }
  
  let targetWs = null;
  
  if (sender.isHost) {
    // Host sending ICE candidate to viewer
    targetWs = room.viewers.get(target);
  } else {
    // Viewer sending ICE candidate to host
    if (room.host && room.host.userId === target) {
      targetWs = room.host;
    }
  }
  
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({
      type: 'ice-candidate',
      sender: sender.userId,
      candidate: candidate,
      timestamp: Date.now()
    }));
    console.log(`📤 Forwarded ICE candidate from ${sender.userId} to ${target}`);
  } else {
    console.log(`❌ Target ${target} not found or not connected`);
  }
}

// HTTP API Routes

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Get server status
app.get('/', (req, res) => {
  const roomsInfo = [];
  rooms.forEach((room, roomId) => {
    roomsInfo.push({
      roomId,
      hasHost: !!room.host,
      viewerCount: room.viewers.size,
      host: room.host ? {
        id: room.host.userId,
        name: room.host.username
      } : null
    });
  });
  
  res.json({
    service: 'SyncFlix WebRTC Signaling Server',
    version: '2.0.0',
    status: 'online',
    documentation: {
      websocket: 'Connect to /ws?room=ROOM_ID&username=NAME&role=host|viewer',
      endpoints: [
        'GET / - Server status',
        'GET /health - Health check',
        'GET /rooms - List all rooms',
        'GET /room/:id - Get room info',
        'POST /room/create - Create new room'
      ]
    },
    rooms: roomsInfo,
    totalRooms: rooms.size,
    totalConnections: Array.from(userSessions.values()).length,
    timestamp: new Date().toISOString()
  });
});

// List all rooms
app.get('/rooms', (req, res) => {
  const roomsList = [];
  rooms.forEach((room, roomId) => {
    roomsList.push({
      roomId,
      hasHost: !!room.host,
      viewerCount: room.viewers.size,
      host: room.host ? {
        id: room.host.userId,
        name: room.host.username
      } : null
    });
  });
  
  res.json({
    rooms: roomsList,
    totalRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Get specific room info
app.get('/room/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const roomInfo = getRoomInfo(roomId);
  
  if (roomInfo) {
    res.json(roomInfo);
  } else {
    res.status(404).json({
      error: 'Room not found',
      message: `Room "${roomId}" does not exist or is empty`,
      timestamp: new Date().toISOString()
    });
  }
});

// Create a new room
app.post('/room/create', (req, res) => {
  const { roomId, username } = req.body;
  
  if (!roomId) {
    return res.status(400).json({
      error: 'Room ID required',
      message: 'Please provide a roomId in the request body',
      timestamp: new Date().toISOString()
    });
  }
  
  // Check if room already exists
  if (rooms.has(roomId) && rooms.get(roomId).host) {
    return res.status(409).json({
      error: 'Room already exists',
      message: `Room "${roomId}" is already active`,
      userCount: rooms.get(roomId).viewers.size + (rooms.get(roomId).host ? 1 : 0),
      timestamp: new Date().toISOString()
    });
  }
  
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers.host;
  
  res.json({
    success: true,
    roomId,
    message: 'Room created (will be active when first user joins)',
    urls: {
      host: `${protocol === 'https' ? 'wss' : 'ws'}://${host}/ws?room=${roomId}&username=${username || 'Host'}&role=host`,
      viewer: `${protocol === 'https' ? 'wss' : 'ws'}://${host}/ws?room=${roomId}&username=Viewer&role=viewer`,
      api: `${protocol}://${host}/room/${roomId}`
    },
    timestamp: new Date().toISOString()
  });
});

// Get user statistics
app.get('/stats', (req, res) => {
  const now = Date.now();
  const activeUsers = Array.from(userSessions.values()).filter(session => {
    // Consider user active if connected in last 5 minutes
    return now - session.connectedAt < 5 * 60 * 1000;
  });
  
  const stats = {
    totalUsers: userSessions.size,
    activeUsers: activeUsers.length,
    totalRooms: rooms.size,
    roomsByUserCount: {},
    timestamp: new Date().toISOString()
  };
  
  // Count rooms by number of users
  rooms.forEach((room, roomId) => {
    const userCount = room.viewers.size + (room.host ? 1 : 0);
    stats.roomsByUserCount[userCount] = (stats.roomsByUserCount[userCount] || 0) + 1;
  });
  
  res.json(stats);
});

// Clean up inactive rooms periodically
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  rooms.forEach((room, roomId) => {
    let hasActiveConnections = false;
    
    // Check host
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      const hostSession = userSessions.get(room.host.userId);
      if (hostSession && now - hostSession.connectedAt < 30 * 60 * 1000) {
        hasActiveConnections = true;
      }
    }
    
    // Check viewers
    if (!hasActiveConnections) {
      for (const viewerWs of room.viewers.values()) {
        if (viewerWs.readyState === WebSocket.OPEN) {
          const viewerSession = userSessions.get(viewerWs.userId);
          if (viewerSession && now - viewerSession.connectedAt < 30 * 60 * 1000) {
            hasActiveConnections = true;
            break;
          }
        }
      }
    }
    
    // Clean up if no active connections for 30 minutes
    if (!hasActiveConnections) {
      rooms.delete(roomId);
      cleanedCount++;
      console.log(`🗑️ Cleaned up inactive room: ${roomId}`);
    }
  });
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} inactive rooms`);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
    🚀 Server running on port ${PORT}
    📡 WebSocket available at ws://localhost:${PORT}/ws
    🌐 HTTP API available at http://localhost:${PORT}
    ⚡ Ready for WebRTC connections!
    
    Endpoints:
    - http://localhost:${PORT}/          - Server status
    - http://localhost:${PORT}/health    - Health check
    - http://localhost:${PORT}/rooms     - List all rooms
    - http://localhost:${PORT}/room/:id  - Get room info
    - POST http://localhost:${PORT}/room/create - Create new room
  `);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  
  // Close all WebSocket connections
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, 'Server shutting down');
    }
  });
  
  // Close server
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, 'Server shutting down');
    }
  });
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});