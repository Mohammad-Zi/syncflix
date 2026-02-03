// server.js - WebSocket Signaling Server for SyncFlix
const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Create HTTP server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SyncFlix Signaling Server is running');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store room data
const rooms = new Map();

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true);
    const roomId = parameters.query.room;
    const userId = Date.now().toString(); // Simple user ID
    
    console.log(`New connection: ${userId} to room ${roomId}`);
    
    if (!roomId) {
        ws.close(1008, 'Room ID required');
        return;
    }
    
    // Initialize room if it doesn't exist
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
    }
    
    const room = rooms.get(roomId);
    
    // Add user to room
    ws.userId = userId;
    ws.roomId = roomId;
    room.set(userId, ws);
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        userId: userId,
        roomId: roomId
    }));
    
    // Notify other users in room
    broadcastToRoom(roomId, userId, {
        type: 'user_joined',
        userId: userId
    });
    
    // Handle messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`Message from ${userId} in ${roomId}:`, data.type);
            
            // Route message to appropriate handler
            handleMessage(ws, roomId, userId, data);
            
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
    
    // Handle disconnect
    ws.on('close', () => {
        console.log(`Connection closed: ${userId} from room ${roomId}`);
        
        // Remove user from room
        if (rooms.has(roomId)) {
            const room = rooms.get(roomId);
            room.delete(userId);
            
            // Notify other users
            broadcastToRoom(roomId, userId, {
                type: 'user_left',
                userId: userId
            });
            
            // Clean up empty rooms
            if (room.size === 0) {
                rooms.delete(roomId);
                console.log(`Room ${roomId} deleted (empty)`);
            }
        }
    });
    
    // Handle errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${userId}:`, error);
    });
});

// Handle different message types
function handleMessage(ws, roomId, userId, data) {
    switch (data.type) {
        case 'offer':
        case 'answer':
        case 'candidate':
        case 'chat':
            // Forward to all other users in the room
            broadcastToRoom(roomId, userId, data);
            break;
            
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
            
        default:
            console.log(`Unknown message type: ${data.type}`);
    }
}

// Broadcast message to all users in room except sender
function broadcastToRoom(roomId, senderId, data) {
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    
    room.forEach((client, userId) => {
        if (userId !== senderId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ SyncFlix Signaling Server running on port ${PORT}`);
    console.log(`📡 WebSocket URL: ws://localhost:${PORT}`);
});

// Clean up empty rooms periodically
setInterval(() => {
    rooms.forEach((room, roomId) => {
        if (room.size === 0) {
            rooms.delete(roomId);
        }
    });
}, 60000); // Every minute