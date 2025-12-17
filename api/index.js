const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// In-memory storage (will persist in bot's memory instead)
// This is just for the web server to validate and queue messages
const sessions = new Map();
const messageQueues = new Map();

// Create new anonymous session
app.post('/api/session/create', (req, res) => {
  const { sessionId, groupJid } = req.body;

  if (!sessionId || !groupJid) {
    return res.status(400).json({ error: 'Missing sessionId or groupJid' });
  }

  sessions.set(sessionId, {
    groupJid,
    active: true,
    createdAt: Date.now(),
    messageCount: 0
  });

  messageQueues.set(sessionId, []);

  res.json({ success: true, sessionId });
});

// End anonymous session
app.post('/api/session/end', (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.active = false;
  res.json({ success: true });
});

// Check if session is active
app.get('/api/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({ active: false, exists: false });
  }

  res.json({
    active: session.active,
    exists: true,
    messageCount: session.messageCount
  });
});

// Submit anonymous message
app.post('/api/message/submit', (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  if (message.trim().length === 0) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
  }

  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(403).json({ error: 'Session has ended' });
  }

  // Increment message count
  session.messageCount++;

  // Add message to queue
  const queue = messageQueues.get(sessionId) || [];
  queue.push({
    number: session.messageCount,
    message: message.trim(),
    timestamp: Date.now()
  });
  messageQueues.set(sessionId, queue);

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
app.get('/:sessionId', (req, res) => {
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
