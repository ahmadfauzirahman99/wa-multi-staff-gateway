'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');
const qrcode     = require('qrcode');
const fileUpload = require('express-fileupload');
const socketIO   = require('socket.io');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const db = require('./db');

// ============================================================
//  CONFIG
// ============================================================
const PORT            = parseInt(process.env.PORT)            || 3030;
const CHAT_LOG_FILE   = process.env.CHAT_LOG_FILE             || 'chats-log.jsonl';
const CRON_TOKEN      = process.env.CRON_TOKEN                || 'RAHASIA_CRON_123';
const API_KEY         = process.env.API_KEY                   || '';
const WEBHOOK_URL     = process.env.WEBHOOK_URL               || '';
const MAX_RETRY       = parseInt(process.env.MAX_RETRY)       || 3;
const QUEUE_DELAY_MIN = parseInt(process.env.QUEUE_DELAY_MIN) || 2000;
const QUEUE_DELAY_MAX = parseInt(process.env.QUEUE_DELAY_MAX) || 5000;
const AUTO_REPLY_ENABLED  = process.env.AUTO_REPLY_ENABLED  === 'true';
const AUTO_BOT_AI_ENABLED = process.env.AUTO_BOT_AI_ENABLED === 'true';
const SESSIONS_FILE   = '.wa-sessions.json';

// ============================================================
//  EXPRESS + SOCKET.IO
// ============================================================
const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(fileUpload());
app.use('/', express.static(path.join(__dirname)));

let clients = {};
let qrStore = {};

// ============================================================
//  RATE LIMITER (kirim langsung)
// ============================================================
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests — slow down' },
});

// ============================================================
//  HELPERS
// ============================================================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizePhone(raw) {
  let n = (raw || '').toString().replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.substring(1);
  return n;
}

function logChat(id, msg) {
  try {
    const entry = {
      clientId: id, from: msg.from, to: msg.to || null,
      body: msg.body, type: msg.type, hasMedia: msg.hasMedia,
      timestamp: new Date().toISOString(),
    };
    fs.appendFile(CHAT_LOG_FILE, JSON.stringify(entry) + '\n', () => {});
  } catch (e) {
    console.error('Gagal log chat:', e.message);
  }
}

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('[WEBHOOK] Error:', e.message);
  }
}

async function generateAiReply(text) {
  return 'AI: Fitur bot AI belum diaktifkan.';
}

// ============================================================
//  SESSION PERSISTENCE (auto-start on reboot)
// ============================================================
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE))
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.keys(clients)));
  } catch (e) {
    console.error('[SESSIONS] Save error:', e.message);
  }
}

// ============================================================
//  AUTH MIDDLEWARE (aktif hanya jika API_KEY diset)
// ============================================================
function apiAuth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key']
    || (req.headers['authorization'] || '').replace('Bearer ', '')
    || req.query.api_key;
  if (key !== API_KEY)
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
}

// ============================================================
//  CONNECT WA PER STAFF (socket room-based)
// ============================================================
function connectWhatsApp(id) {
  if (clients[id]) return;

  console.log(`\n[${id}] Starting WhatsApp Web.js...`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', async (qr) => {
    qrStore[id] = qr;
    const img = await qrcode.toDataURL(qr);
    io.to('staff:' + id).emit('qr:' + id, img);
    console.log(`[${id}] QR Generated`);
  });

  client.on('ready', () => {
    console.log(`[${id}] WhatsApp READY`);
    clients[id] = client;
    delete qrStore[id];
    saveSessions();
    io.to('staff:' + id).emit('connected:' + id, { status: 'connected' });
  });

  client.on('authenticated', () => {
    console.log(`[${id}] Authenticated`);
  });

  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    const fromNum = msg.from.replace('@c.us', '');
    console.log(`[${id}] Pesan masuk dari ${fromNum}: ${msg.body}`);
    logChat(id, msg);

    try {
      await db.query(
        'INSERT INTO wa_incoming (staff_id, from_number, body, msg_type, has_media) VALUES (?,?,?,?,?)',
        [id, fromNum, msg.body || '', msg.type || 'chat', msg.hasMedia ? 1 : 0]
      );
    } catch (e) {
      console.error('[DB] Gagal simpan incoming:', e.message);
    }

    io.emit('wa-new-incoming', { staff_id: id, from: fromNum, body: msg.body, type: msg.type });
    sendWebhook({ event: 'incoming', staff_id: id, from: fromNum, body: msg.body, type: msg.type });

    try {
      if (AUTO_BOT_AI_ENABLED) {
        const reply = await generateAiReply(msg.body);
        await msg.reply(reply);
      } else if (AUTO_REPLY_ENABLED) {
        await msg.reply('Pesan sudah diterima. Terima kasih 🙏');
      }
    } catch (e) {
      console.error(`[${id}] Gagal auto-reply:`, e.message);
    }
  });

  client.on('message_ack', (msg, ack) => {
    const statusMap = { 1: 'sent', 2: 'delivered', 3: 'read' };
    const status = statusMap[ack];
    if (!status) return;

    console.log(`[ACK] ${msg.id.id} => ${status}`);
    db.query('UPDATE wa_outgoing SET status=?, updated_at=NOW() WHERE message_id=?', [status, msg.id.id])
      .catch(err => console.error('Gagal update status:', err.message));

    io.emit('wa-status-update', { messageId: msg.id.id, status });
    sendWebhook({ event: 'ack', message_id: msg.id.id, status });
  });

  client.on('disconnected', (reason) => {
    console.log(`[${id}] Disconnected (${reason}) — reconnect in 3s...`);
    client.destroy();
    delete clients[id];
    io.to('staff:' + id).emit('wa-reconnecting:' + id, { reason });
    setTimeout(() => connectWhatsApp(id), 3000);
  });

  client.initialize();
}

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  socket.on('check-auth', async ({ id }) => {
    if (!id) return;
    socket.join('staff:' + id);

    if (clients[id]) {
      socket.emit('connected:' + id, { status: 'connected' });
      return;
    }
    if (qrStore[id]) {
      const img = await qrcode.toDataURL(qrStore[id]);
      socket.emit('qr:' + id, img);
      return;
    }
    connectWhatsApp(id);
  });
});

// ============================================================
//  MIDDLEWARE: auth untuk semua /api/ kecuali /health
// ============================================================
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  apiAuth(req, res, next);
});

// Rate limit pada kirim langsung
app.use(['/api/send-text', '/api/send-media', '/api/broadcast-text'], sendLimiter);

// ============================================================
//  API: HEALTH CHECK
// ============================================================
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { await db.query('SELECT 1'); dbOk = true; } catch {}
  res.json({
    success: true,
    uptime: Math.floor(process.uptime()),
    db: dbOk ? 'ok' : 'error',
    clients: Object.keys(clients).length,
    client_ids: Object.keys(clients),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
//  API: LIST CLIENT AKTIF
// ============================================================
app.get('/api/clients', (req, res) => {
  res.json({ success: true, clients: Object.keys(clients).map(id => ({ id, connected: true })) });
});

// ============================================================
//  API: QUEUE STATS
// ============================================================
app.get('/api/queue/stats', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT status, COUNT(*) as count FROM wa_outgoing GROUP BY status');
    const stats = {};
    rows.forEach(r => { stats[r.status] = Number(r.count); });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: RESET FAILED → PENDING
// ============================================================
app.post('/api/queue/reset-failed', async (req, res) => {
  try {
    const { staff_id } = req.body;
    let sql  = "UPDATE wa_outgoing SET status='pending', retry_count=0, updated_at=NOW() WHERE status='failed'";
    const params = [];
    if (staff_id) { sql += ' AND staff_id=?'; params.push(staff_id); }
    const [result] = await db.query(sql, params);
    res.json({ success: true, affected: result.affectedRows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: LIST OUTGOING (dengan pagination)
// ============================================================
app.get('/api/outgoing', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(500, parseInt(req.query.limit) || 200);
    const offset = (page - 1) * limit;
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM wa_outgoing');
    const [rows] = await db.query(
      'SELECT id, staff_id, wa_number, message, msg_type, file_name, status, message_id, retry_count, scheduled_at, created_at, updated_at FROM wa_outgoing ORDER BY id DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    res.json({ success: true, data: rows, total: Number(total), page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: LIST INCOMING
// ============================================================
app.get('/api/incoming', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(500, parseInt(req.query.limit) || 100);
    const offset = (page - 1) * limit;
    const [rows] = await db.query(
      'SELECT * FROM wa_incoming ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]
    );
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM wa_incoming');
    res.json({ success: true, data: rows, total: Number(total), page, limit });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: SEND TEXT
// ============================================================
app.post('/api/send-text', async (req, res) => {
  const { id, phone, message } = req.body;
  if (!id || !phone || !message)
    return res.status(400).json({ success: false, message: 'Param kurang' });

  const client = clients[id];
  if (!client) return res.status(400).json({ success: false, message: 'WA belum connect' });

  const number = normalizePhone(phone);
  const waId   = number + '@c.us';

  try {
    const isReg = await client.isRegisteredUser(waId);
    if (!isReg) {
      await db.query(
        'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?,?,?,?,?)',
        [id, number, message, 'text', 'not_registered']
      );
      return res.status(400).json({ success: false, message: 'Nomor tidak terdaftar', wa_number: number });
    }

    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?,?,?,?,?)',
      [id, number, message, 'text', 'pending']
    );
    const dbId = result.insertId;
    const sent = await client.sendMessage(waId, message);
    await db.query("UPDATE wa_outgoing SET message_id=?, status='sent' WHERE id=?", [sent.id.id, dbId]);
    io.emit('wa-new-outgoing', { id: dbId, staff_id: id, wa_number: number, message, msg_type: 'text', status: 'sent' });
    res.json({ success: true, messageId: sent.id.id, dbId });
  } catch (err) {
    console.error('ERROR /api/send-text:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: SEND MEDIA (dengan caption opsional)
// ============================================================
app.post('/api/send-media', async (req, res) => {
  const { id, phone, filename, fileData, caption } = req.body;
  if (!id || !phone || !filename || !fileData)
    return res.status(400).json({ success: false, message: 'Param kurang' });

  const client = clients[id];
  if (!client) return res.status(400).json({ success: false, message: 'WA belum connect' });

  const number = normalizePhone(phone);
  const waId   = number + '@c.us';

  try {
    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?,?,?,?,?)',
      [id, number, filename, 'file', 'pending']
    );
    const dbId  = result.insertId;
    const media = new MessageMedia('*/*', fileData, filename);
    const sent  = await client.sendMessage(waId, media, caption ? { caption } : {});
    await db.query("UPDATE wa_outgoing SET message_id=?, status='sent' WHERE id=?", [sent.id.id, dbId]);
    io.emit('wa-new-outgoing', { id: dbId, staff_id: id, wa_number: number, message: filename, msg_type: 'file', status: 'sent' });
    res.json({ success: true, messageId: sent.id.id, dbId });
  } catch (err) {
    console.error('ERROR /api/send-media:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: BROADCAST TEXT (dengan delay)
// ============================================================
app.post('/api/broadcast-text', async (req, res) => {
  const { id, message, phones } = req.body;
  if (!id || !message || !Array.isArray(phones) || !phones.length)
    return res.status(400).json({ success: false, message: 'Param kurang' });

  const client = clients[id];
  if (!client) return res.status(400).json({ success: false, message: 'WA belum connect' });

  const results = [];
  for (let i = 0; i < phones.length; i++) {
    const number = normalizePhone(phones[i]);
    if (!number) continue;
    const waId = number + '@c.us';
    try {
      const [ins] = await db.query(
        'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?,?,?,?,?)',
        [id, number, message, 'text', 'pending']
      );
      const dbId = ins.insertId;
      const sent = await client.sendMessage(waId, message);
      await db.query("UPDATE wa_outgoing SET message_id=?, status='sent' WHERE id=?", [sent.id.id, dbId]);
      results.push({ phone: phones[i], success: true, id: sent.id.id, dbId });
      io.emit('wa-new-outgoing', { id: dbId, staff_id: id, wa_number: number, message, msg_type: 'text', status: 'sent' });
    } catch (e) {
      results.push({ phone: phones[i], success: false, error: e.message });
    }
    if (i < phones.length - 1)
      await sleep(QUEUE_DELAY_MIN + Math.random() * (QUEUE_DELAY_MAX - QUEUE_DELAY_MIN));
  }
  res.json({ success: true, results });
});

// ============================================================
//  API: QUEUE TEXT (dengan scheduled_at opsional)
// ============================================================
app.post('/api/queue-text', async (req, res) => {
  try {
    const { staff_id, wa_number, message, scheduled_at } = req.body;
    if (!staff_id || !wa_number || !message)
      return res.status(400).json({ success: false, message: 'staff_id, wa_number, message wajib' });

    const number = normalizePhone(wa_number);
    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status, scheduled_at) VALUES (?,?,?,?,?,?)',
      [staff_id, number, message, 'text', 'pending', scheduled_at || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: QUEUE PDF
// ============================================================
app.post('/api/queue-pdf', async (req, res) => {
  try {
    let { staff_id, wa_number, caption, file_name, file_base64, scheduled_at } = req.body;
    if (!staff_id || !wa_number || !file_name || !file_base64)
      return res.status(400).json({ success: false, message: 'staff_id, wa_number, file_name, file_base64 wajib' });

    const prefix = 'data:application/pdf;base64,';
    if (file_base64.startsWith(prefix)) file_base64 = file_base64.substring(prefix.length);

    const number = normalizePhone(wa_number);
    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, file_name, file_mime, file_data, msg_type, status, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [staff_id, number, caption || '', file_name, 'application/pdf', file_base64, 'pdf', 'pending', scheduled_at || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: QUEUE MEDIA (gambar / file non-PDF)
// ============================================================
app.post('/api/queue-media', async (req, res) => {
  try {
    let { staff_id, wa_number, file_name, file_mime, file_base64, caption, scheduled_at } = req.body;
    if (!staff_id || !wa_number || !file_name || !file_base64)
      return res.status(400).json({ success: false, message: 'staff_id, wa_number, file_name, file_base64 wajib' });

    // strip data URI prefix if present
    if (file_base64.includes(';base64,'))
      file_base64 = file_base64.split(';base64,')[1];

    const number = normalizePhone(wa_number);
    const [result] = await db.query(
      'INSERT INTO wa_outgoing (staff_id, wa_number, message, file_name, file_mime, file_data, msg_type, status, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [staff_id, number, caption || '', file_name, file_mime || '*/*', file_base64, 'file', 'pending', scheduled_at || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: LOGOUT
// ============================================================
app.post('/api/logout', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: 'ID wajib' });

  const client = clients[id];
  if (!client) return res.status(400).json({ success: false, message: 'Client tidak ditemukan' });

  try {
    await client.logout();
    await client.destroy();
    delete clients[id];
    delete qrStore[id];
    saveSessions();

    const sessPath = `.wwebjs_auth/session-${id}`;
    if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });

    io.emit('wa-client-logout', { id });
    res.json({ success: true, message: `Client ${id} berhasil logout` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: RUN CRON
// ============================================================
app.get('/api/run-cron', async (req, res) => {
  const token = req.query.token || req.headers['x-cron-token'] || '';
  if (token !== CRON_TOKEN)
    return res.status(403).json({ success: false, message: 'Forbidden' });

  try {
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const result = await processQueue(limit);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
//  QUEUE PROCESSOR (delay + retry + scheduled_at)
// ============================================================
async function processQueue(limit = 20) {
  const [rows] = await db.query(
    "SELECT * FROM wa_outgoing WHERE status='pending' AND (scheduled_at IS NULL OR scheduled_at <= NOW()) ORDER BY id ASC LIMIT ?",
    [limit]
  );

  let successCount = 0, failCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const dbId = row.id;

    try {
      const client = clients[row.staff_id];
      if (!client) {
        await db.query("UPDATE wa_outgoing SET status='failed', updated_at=NOW() WHERE id=?", [dbId]);
        failCount++;
        continue;
      }

      const number = normalizePhone(row.wa_number);
      const waId   = number + '@c.us';

      const isReg = await client.isRegisteredUser(waId);
      if (!isReg) {
        await db.query("UPDATE wa_outgoing SET status='not_registered', updated_at=NOW() WHERE id=?", [dbId]);
        failCount++;
        continue;
      }

      let sent;
      if (row.msg_type === 'pdf' || row.msg_type === 'file') {
        if (!row.file_data) {
          await db.query("UPDATE wa_outgoing SET status='failed', updated_at=NOW() WHERE id=?", [dbId]);
          failCount++;
          continue;
        }
        const mime    = row.file_mime || (row.msg_type === 'pdf' ? 'application/pdf' : '*/*');
        const media   = new MessageMedia(mime, row.file_data, row.file_name || 'file');
        const caption = row.caption || row.message || '';
        sent = await client.sendMessage(waId, media, caption ? { caption } : {});
      } else {
        sent = await client.sendMessage(waId, row.message || '');
      }

      await db.query(
        "UPDATE wa_outgoing SET status='sent', message_id=?, updated_at=NOW() WHERE id=?",
        [sent.id.id, dbId]
      );
      io.emit('wa-status-update', { dbId, messageId: sent.id.id, status: 'sent' });
      successCount++;

    } catch (e) {
      console.error('QUEUE ERROR id=', dbId, e.message);
      const retryCount = (row.retry_count || 0) + 1;
      if (retryCount < MAX_RETRY) {
        await db.query(
          'UPDATE wa_outgoing SET retry_count=?, updated_at=NOW() WHERE id=?',
          [retryCount, dbId]
        );
        console.log(`[QUEUE] id=${dbId} retry ${retryCount}/${MAX_RETRY}`);
      } else {
        await db.query(
          "UPDATE wa_outgoing SET status='failed', retry_count=?, updated_at=NOW() WHERE id=?",
          [retryCount, dbId]
        );
      }
      failCount++;
    }

    if (i < rows.length - 1)
      await sleep(QUEUE_DELAY_MIN + Math.random() * (QUEUE_DELAY_MAX - QUEUE_DELAY_MIN));
  }

  return { total: rows.length, success: successCount, failed: failCount };
}

// ============================================================
//  API: TEMPLATES
// ============================================================
app.get('/api/templates', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM wa_templates ORDER BY name ASC');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, content } = req.body;
    if (!name || !content)
      return res.status(400).json({ success: false, message: 'name dan content wajib' });
    await db.query(
      'INSERT INTO wa_templates (name, content) VALUES (?,?) ON DUPLICATE KEY UPDATE content=VALUES(content)',
      [name, content]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM wa_templates WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
//  GRACEFUL SHUTDOWN
// ============================================================
async function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received — shutting down...`);
  for (const [id, client] of Object.entries(clients)) {
    try { await client.destroy(); console.log(`[SHUTDOWN] Client ${id} destroyed`); } catch {}
  }
  try { await db.end(); } catch {}
  server.close(() => { console.log('[SHUTDOWN] Server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ============================================================
//  RUN SERVER + AUTO-START
// ============================================================
server.listen(PORT, () => {
  console.log(`\n🚀 Server: http://localhost:${PORT}`);
  console.log(`📱 QR Scanner:  http://localhost:${PORT}/qr-scanner.html`);
  console.log(`📊 Dashboard:   http://localhost:${PORT}/wa-dashboard.html`);
  console.log(`📊 Monitoring:  http://localhost:${PORT}/outgoing-dashboard.html`);
  console.log(`❤  Health:     http://localhost:${PORT}/api/health`);
  if (API_KEY)     console.log(`🔐 API Key aktif`);
  if (WEBHOOK_URL) console.log(`🔗 Webhook: ${WEBHOOK_URL}`);

  // Auto-reconnect staff dari sesi sebelumnya
  const saved = loadSessions();
  if (saved.length > 0) {
    console.log(`\n[AUTO-START] Reconnecting: ${saved.join(', ')}`);
    saved.forEach(id => connectWhatsApp(id));
  }
});
