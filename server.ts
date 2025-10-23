import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import eventRoutes from './routes/events.js';
import userRoutes from './routes/users.js';
import departmentRoutes from './routes/departments.js';
import resourceAvailabilityRoutes from './routes/resourceAvailability.js';
import locationAvailabilityRoutes from './routes/locationAvailability.js';
import departmentPermissionsRoutes from './routes/departmentPermissions.js';
import messageRoutes from './routes/messages.js';
import notificationRoutes from './routes/notifications.js';
import loginLogsRoutes from './routes/loginLogs.js';
import userActivityLogsRoutes from './routes/userActivityLogs.js';
import { startScheduler, runCleanupNow } from './services/scheduler.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const envPath = path.join(__dirname, '.env');
console.log('🔍 Looking for .env file at:', envPath);
const result = dotenv.config({ path: envPath, debug: true });
console.log('📋 Environment variables loaded:', Object.keys(process.env).filter(key => 
  ['MONGODB_URI', 'PORT', 'JWT_SECRET', 'JWT_EXPIRES_IN', 'NODE_ENV'].includes(key)
));

const app = express();
const httpServer = createServer(app);

// CORS allowed origins from environment variable or defaults
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',') 
  : ["http://localhost:5173", "http://localhost:8080", "http://localhost:3000"];

console.log('🌐 CORS allowed origins:', allowedOrigins);

// Re-enable Socket.IO server with proper connection management
const io = new Server(httpServer, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        console.log('❌ Socket.IO CORS blocked origin:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  // Add connection limits to prevent spam
  maxHttpBufferSize: 1e6, // 1MB
  pingTimeout: 60000,
  pingInterval: 25000,
  // Limit connections per IP
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  }
});

console.log('🔌 Socket.IO server re-enabled with connection management');

// Make Socket.IO instance available to routes
app.set('io', io);

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;

// Trust proxy - required for Coolify/reverse proxy setups
app.set('trust proxy', 1);

// Middleware - CORS configuration with preflight support
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('❌ CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Make io available to routes (disabled)
app.set('io', io);

// Socket.IO connection handling with proper tracking
const connectedUsers = new Map(); // Track connected users to prevent duplicates

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  // Join user to their personal room (for receiving messages)
  socket.on('join-user-room', (userId) => {
    // Check if user is already connected with a different socket
    if (connectedUsers.has(userId)) {
      const oldSocketId = connectedUsers.get(userId);
      if (oldSocketId !== socket.id) {
        console.log(`🔄 User ${userId} reconnecting - updating socket ID from ${oldSocketId} to ${socket.id}`);
        // Update to new socket ID
        connectedUsers.set(userId, socket.id);
      } else {
        console.log(`✅ User ${userId} already in room with same socket`);
      }
    } else {
      console.log(`👤 New user ${userId} joining room`);
      connectedUsers.set(userId, socket.id);
    }

    // Always join the room (in case of reconnection)
    socket.join(`user-${userId}`);
    console.log(`✅ User ${userId} is now in room user-${userId}`);
  });

  // Test connection handler
  socket.on('test-connection', (data) => {
    console.log('🧪 Test connection received:', data);
    socket.emit('test-response', { message: 'Connection test successful', timestamp: new Date() });
  });

  // Join conversation room with rate limiting
  socket.on('join-conversation', (conversationId) => {
    socket.join(`conversation-${conversationId}`);
    console.log(`💬 User joined conversation: ${conversationId}`);
  });

  // Leave conversation room
  socket.on('leave-conversation', (conversationId) => {
    socket.leave(`conversation-${conversationId}`);
    console.log(`👋 User left conversation: ${conversationId}`);
  });

  socket.on('disconnect', () => {
    // Clean up user tracking
    for (const [userId, socketId] of connectedUsers.entries()) {
      if (socketId === socket.id) {
        connectedUsers.delete(userId);
        console.log(`🔌 User disconnected and cleaned up`);
        break;
      }
    }
  });
});

// Routes
app.use('/api/events', eventRoutes);
app.use('/api/users', userRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/resource-availability', resourceAvailabilityRoutes);
app.use('/api/location-availability', locationAvailabilityRoutes);
app.use('/api/department-permissions', departmentPermissionsRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/login-logs', loginLogsRoutes);
app.use('/api/user-activity-logs', userActivityLogsRoutes);

// Health check route
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'PGB Event Scheduler API is running!',
    timestamp: new Date().toISOString()
  });
});

// Manual cleanup trigger route (for testing)
app.post('/api/cleanup-now', async (req, res) => {
  try {
    console.log('🧹 Manual cleanup triggered via API...');
    const result = await runCleanupNow();
    
    res.json({
      success: true,
      message: 'Cleanup completed successfully',
      result: result
    });
  } catch (error) {
    console.error('❌ Manual cleanup failed:', error);
    res.status(500).json({
      success: false,
      message: 'Cleanup failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// MongoDB Connection
const connectDB = async () => {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }

    console.log('🔄 Connecting to MongoDB Atlas...');
    
    await mongoose.connect(MONGODB_URI);
    
    console.log('✅ MongoDB Atlas connected successfully!');
    console.log(`📊 Database: ${mongoose.connection.db?.databaseName}`);
    console.log(`🌐 Host: ${mongoose.connection.host}`);
    
    // Start the automated scheduler
    startScheduler();
    
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    process.exit(1);
  }
};

// Start server
const startServer = async () => {
  try {
    await connectDB();
    
    httpServer.listen(PORT, () => {
      console.log('🚀 PGB Event Scheduler Backend Server Started!');
      console.log(`📡 Server running on: http://localhost:${PORT}`);
      console.log(`🔌 Socket.IO enabled with connection management and spam prevention`);
      console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
      console.log(`📅 Events API: http://localhost:${PORT}/api/events`);
      console.log(`👥 Users API: http://localhost:${PORT}/api/users`);
      console.log(`💬 Messages API: http://localhost:${PORT}/api/messages`);
      console.log(`🏢 Departments API: http://localhost:${PORT}/api/departments`);
      console.log(`📦 Resource Availability API: http://localhost:${PORT}/api/resource-availability`);
      console.log(`🗺️ Location Availability API: http://localhost:${PORT}/api/location-availability`);
      console.log('─'.repeat(50));
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
