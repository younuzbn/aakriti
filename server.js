const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const http = require('http');
const path = require('path');
require('dotenv').config();

const connectDB = require('./config/database');
const errorHandler = require('./middleware/errorHandler');

// Aakriti routes (unchanged from the Kochi One backend)
const aakritiRoutes = require('./routes/aakritiRoutes');
const aakritiPortalRoutes = require('./routes/aakritiPortal');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Behind Nginx / Cloudflare: trust the first proxy for correct client IP / protocol
app.set('trust proxy', 1);

// Static files (portal pages, logos, uploaded stylist photos/videos)
app.use(express.static(path.join(__dirname, 'public')));

// Connect to database
connectDB();

// ── Security + CORS ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
          scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'https://static.cloudflareinsights.com', 'https://cdn.jsdelivr.net'],
          scriptSrcAttr: ["'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:', '*'],
          workerSrc: ["'self'", 'blob:'],
          // XHR/fetch + Socket.IO (websocket). Cloudflare terminates TLS (wss://)
          connectSrc: ["'self'", 'https:', 'wss:', 'ws:'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"]
        }
      },
      crossOriginEmbedderPolicy: false,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    })
  );

  app.use(
    cors({
      origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, same-origin)
        if (!origin) return callback(null, true);

        const allowedOrigins = [
          'https://kochi.one',
          'https://www.kochi.one',
          'https://api.kochi.one',
          'https://admin.kochi.one',
          'https://review.kochi.one',
          'https://menu.kochi.one',
          // Aakriti customer booking domains
          'https://aakritimakeoverstudio.com',
          'https://www.aakritimakeoverstudio.com',
          'https://bookings.aakritimakeoverstudio.com',
          'http://localhost:3000',
          'http://localhost:3001',
          'http://localhost:3002',
          'http://localhost:3005',
          'http://localhost:3006',
          'http://localhost:3007',
          'http://localhost:3008'
        ];

        // http(s)://localhost:any-port and 127.0.0.1
        if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
          return callback(null, true);
        }

        // Chrome extensions
        if (origin.startsWith('chrome-extension://')) {
          return callback(null, true);
        }

        // Any subdomain of allowed domain families
        if (
          origin.endsWith('.kochi.one') ||
          origin === 'https://kochi.one' ||
          origin === 'https://www.kochi.one' ||
          origin.endsWith('.aakritimakeoverstudio.com') ||
          origin === 'https://aakritimakeoverstudio.com' ||
          origin === 'https://www.aakritimakeoverstudio.com'
        ) {
          return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        // CORS_ORIGIN env var (comma-separated list, or *)
        const envOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : [];
        if (envOrigins.includes(origin) || envOrigins.includes('*')) {
          return callback(null, true);
        }

        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-aakriti-token']
    })
  );
} else {
  // Development
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    })
  );
  app.use(
    cors({
      origin: true,
      credentials: true
    })
  );
}

app.use(morgan('combined'));
app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ── Routes (same paths as in the Kochi One backend) ──────────────────────────
// Customer API:  /api/aakriti/*
app.use('/api/aakriti', aakritiRoutes.router);
// Staff portal API (/api/aakriti/portal/*) + portal pages (/aakriti/login, /aakriti/dashboard, ...)
app.use(aakritiPortalRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Aakriti API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root -> staff portal login
app.get('/', (req, res) => {
  res.redirect('/aakriti/login');
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Route not found'
  });
});

// Global error handler
app.use(errorHandler);

// ── Socket.IO (realtime queue updates) ───────────────────────────────────────
const { Server: SocketIOServer } = require('socket.io');
const io = new SocketIOServer(server, {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// Exposed to routes via req.app.get('io')
app.set('io', io);

io.on('connection', (socket) => {
  // Customer follows their own booking
  socket.on('join_aakriti_booking', (bookingId) => {
    if (typeof bookingId === 'string' && bookingId.trim()) {
      socket.join(`aakriti:booking:${bookingId.trim()}`);
    }
  });
  socket.on('leave_aakriti_booking', (bookingId) => {
    if (typeof bookingId === 'string' && bookingId.trim()) {
      socket.leave(`aakriti:booking:${bookingId.trim()}`);
    }
  });
  // Staff dashboards watch for any queue change
  socket.on('join_aakriti_watch', () => {
    socket.join('aakriti:watch');
  });
  socket.on('leave_aakriti_watch', () => {
    socket.leave('aakriti:watch');
  });
});

server.listen(PORT, () => {
  console.log(`Aakriti server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
