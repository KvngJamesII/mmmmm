const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// Secret key for signing sessions (in production, use env variable)
const SECRET_KEY = process.env.SESSION_SECRET || 'luca-anonymous-secret-2024';

// In-memory storage - reinitializes on serverless cold starts, but that's OK now
// because we validate sessions using signatures
const sessions = new Map();
const messageQueues = new Map();
const endedSessions = new Set(); // Track explicitly ended sessions

// Helper: Generate signature for session validation
const generateSignature = (sessionId, groupJid, createdAt) => {
  const data = `${sessionId}:${groupJid}:${createdAt}`;
  return crypto.createHmac('sha256', SECRET_KEY).update(data).digest('hex').substring(0, 16);
};

// Helper: Validate session token
const validateSessionToken = (token) => {
  try {
    // Token format: sessionId_groupJid_createdAt_signature
    const parts = token.split('_');
    if (parts.length !== 4) return null;
    
    const [sessionId, groupJidEncoded, createdAt, signature] = parts;
    const groupJid = Buffer.from(groupJidEncoded, 'base64').toString('utf-8');
    
    // Check signature
    const expectedSig = generateSignature(sessionId, groupJid, createdAt);
    if (signature !== expectedSig) return null;
    
    // Check if session was explicitly ended
    if (endedSessions.has(sessionId)) return null;
    
    // Check 20-minute expiry
    const age = Date.now() - parseInt(createdAt);
    const TWENTY_MINUTES = 20 * 60 * 1000;
    if (age > TWENTY_MINUTES) return null;
    
    return { sessionId, groupJid, createdAt: parseInt(createdAt) };
  } catch (e) {
    return null;
  }
};

// Create new anonymous session
app.post('/api/session/create', (req, res) => {
  const { sessionId, groupJid, createdAt } = req.body;

  if (!sessionId || !groupJid) {
    return res.status(400).json({ error: 'Missing sessionId or groupJid' });
  }

  const timestamp = createdAt || Date.now();
  const signature = generateSignature(sessionId, groupJid, timestamp);
  const groupJidEncoded = Buffer.from(groupJid).toString('base64');
  const token = `${sessionId}_${groupJidEncoded}_${timestamp}_${signature}`;

  sessions.set(sessionId, {
    groupJid,
    active: true,
    createdAt: timestamp,
    messageCount: 0,
    lastActivity: timestamp
  });

  messageQueues.set(sessionId, []);

  res.json({ success: true, sessionId, token });
});

// End anonymous session
app.post('/api/session/end', (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  // Add to ended sessions set
  endedSessions.add(sessionId);

  const session = sessions.get(sessionId);
  if (session) {
    session.active = false;
  }

  res.json({ success: true });
});

// Check if session is active (validates using token from URL)
app.get('/api/session/:token/status', (req, res) => {
  const { token } = req.params;
  
  // Validate the token
  const sessionData = validateSessionToken(token);
  
  if (!sessionData) {
    return res.json({ active: false, exists: false });
  }
  
  // Session is valid - ensure it exists in memory
  if (!sessions.has(sessionData.sessionId)) {
    sessions.set(sessionData.sessionId, {
      groupJid: sessionData.groupJid,
      active: true,
      createdAt: sessionData.createdAt,
      messageCount: 0,
      lastActivity: Date.now()
    });
    messageQueues.set(sessionData.sessionId, []);
  }
  
  const session = sessions.get(sessionData.sessionId);
  
  res.json({
    active: session.active && !endedSessions.has(sessionData.sessionId),
    exists: true,
    messageCount: session.messageCount
  });
});

// Submit anonymous message
app.post('/api/message/submit', (req, res) => {
  const { sessionToken, message } = req.body;

  if (!sessionToken || !message) {
    return res.status(400).json({ error: 'Missing sessionToken or message' });
  }

  if (message.trim().length === 0) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
  }

  // Validate token
  const sessionData = validateSessionToken(sessionToken);
  if (!sessionData) {
    return res.status(403).json({ error: 'Session has ended or expired' });
  }
  
  if (endedSessions.has(sessionData.sessionId)) {
    return res.status(403).json({ error: 'Session has ended' });
  }

  // Ensure session exists in memory
  if (!sessions.has(sessionData.sessionId)) {
    sessions.set(sessionData.sessionId, {
      groupJid: sessionData.groupJid,
      active: true,
      createdAt: sessionData.createdAt,
      messageCount: 0,
      lastActivity: Date.now()
    });
    messageQueues.set(sessionData.sessionId, []);
  }

  const session = sessions.get(sessionData.sessionId);

  if (!session.active) {
    return res.status(403).json({ error: 'Session has ended' });
  }

  // Increment message count and update activity
  session.messageCount++;
  session.lastActivity = Date.now();

  // Add message to queue
  const queue = messageQueues.get(sessionData.sessionId) || [];
  queue.push({
    number: session.messageCount,
    message: message.trim(),
    timestamp: Date.now()
  });
  messageQueues.set(sessionData.sessionId, queue);

  res.json({
    success: true,
    messageNumber: session.messageCount
  });
});

// Bot polls for new messages
app.get('/api/messages/poll/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const queue = messageQueues.get(sessionId) || [];

  // Return all messages and clear queue
  messageQueues.set(sessionId, []);

  res.json({ messages: queue });
});

// Serve the anonymous message page
app.get('/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// For Vercel serverless
module.exports = app;

// For local development
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Anonymous message server running on port ${PORT}`);
  });
}
