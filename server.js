// ==========================================================
//  WHATSAPP MULTI-STAFF BACKEND (WWEBJS VERSION)
//  Fitur:
//  - Multi staff (ID bebas)
//  - QR via Socket.IO (qr-scanner.html)
//  - Kirim teks (/api/send-text)
//  - Kirim media/file (/api/send-media)
//  - Broadcast teks (/api/broadcast-text)
//  - Auto-reply sederhana
//  - Hook Auto bot AI (opsional, via generateAiReply)
//  - Save chat ke file "chats-log.jsonl"
//  - Dashboard client aktif (/api/clients)
// ==========================================================

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const qrcode = require("qrcode");
const fileUpload = require("express-fileupload");
const socketIO = require("socket.io");
const fs = require("fs");

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ====== CONFIG SIMPLE ======
const PORT = 3000;
const CHAT_LOG_FILE = "chats-log.jsonl";
const AUTO_REPLY_ENABLED = false;     // auto balas text sederhana
const AUTO_BOT_AI_ENABLED = false;   // kalau mau pakai AI, ubah ke true dan isi generateAiReply()

// ==========================================================
//  EXPRESS SERVER + SOCKET.IO
// ==========================================================
const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(fileUpload());

// SERVE FRONTEND FILES (qr-scanner.html, send-media.html, wa-dashboard.html)
app.use("/", express.static(path.join(__dirname)));

// GLOBAL STORE
let clients = {};    // client per ID staff
let qrStore = {};    // qr per ID staff

// ==========================================================
//  FUNGSI LOG CHAT KE "DATABASE" FILE
// ==========================================================
function logChat(id, msg) {
    try {
        const entry = {
            clientId: id,
            from: msg.from,
            to: msg.to || null,
            body: msg.body,
            type: msg.type,
            hasMedia: msg.hasMedia,
            timestamp: new Date().toISOString()
        };
        fs.appendFile(
            CHAT_LOG_FILE,
            JSON.stringify(entry) + "\n",
            () => {}
        );
    } catch (e) {
        console.error("Gagal log chat:", e.message);
    }
}

// ==========================================================
//  OPSIONAL: AUTO BOT AI (ISI SENDIRI KE OPENAI / API LAIN)
// ==========================================================
async function generateAiReply(textUser) {
    // TODO: Hubungkan ke API AI kamu sendiri di sini.
    // Sementara ini dummy reply sederhana.
    return `AI Bot: Anda mengirim pesan "${textUser}". Fitur AI belum dikonfigurasi.`;
}

// ==========================================================
//  CONNECT WHATSAPP FUNCTION
// ==========================================================
async function connectWhatsApp(id, socket) {
    console.log(`\n[${id}] Starting WhatsApp Web.js...`);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: id,   // akan membuat folder .wwebjs_auth/session-id
        }),
        puppeteer: {
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage"
            ]
        }
    });

    clients[id] = client;

    // ========== QR ==========
    client.on("qr", async (qr) => {
        qrStore[id] = qr;

        const img = await qrcode.toDataURL(qr);
        socket.emit("qr:" + id, img);
        socket.emit("log:" + id, "Scan QR dengan WhatsApp HP kamu.");

        console.log(`[${id}] QR Generated`);
    });

    // ========== READY ==========
    client.on("ready", () => {
        console.log(`[${id}] WhatsApp READY`);
        socket.emit("connected:" + id, { status: "connected" });
    });

    // ========== AUTH ==========
    client.on("authenticated", () => {
        console.log(`[${id}] Authenticated`);
    });

    // ========== PESAN MASUK ==========
    client.on("message", async (msg) => {
        // Hindari self-loop
        if (msg.fromMe) return;

        console.log(`[${id}] Pesan masuk dari ${msg.from}: ${msg.body}`);
        logChat(id, msg);

        try {
            if (AUTO_BOT_AI_ENABLED) {
                const reply = await generateAiReply(msg.body);
                await msg.reply(reply);
            } else if (AUTO_REPLY_ENABLED) {
                await msg.reply("Terima kasih, pesan Anda sudah kami terima. 😊");
            }
        } catch (e) {
            console.error(`[${id}] Gagal auto-reply:`, e.message);
        }
    });

    // ========== DISCONNECTED → RECONNECT ==========
    client.on("disconnected", (reason) => {
        console.log(`[${id}] Disconnected (${reason}) — Reconnecting...`);
        client.destroy();
        delete clients[id];
        setTimeout(() => connectWhatsApp(id, socket), 2000);
    });

    // START
    client.initialize();
}

// ==========================================================
//  SOCKET.IO HANDLER (SCAN QR)
// ==========================================================
io.on("connection", (socket) => {
    console.log("Browser connected");

    socket.on("check-auth", async ({ id }) => {
        if (!id) return;

        socket.emit("log:" + id, "Memeriksa sesi WhatsApp...");

        // Kalau client sudah aktif
        if (clients[id]) {
            socket.emit("connected:" + id, { status: "connected" });
            return;
        }

        // Kalau sudah ada QR tersimpan
        if (qrStore[id]) {
            const img = await qrcode.toDataURL(qrStore[id]);
            socket.emit("qr:" + id, img);
            return;
        }

        // Mulai koneksi baru
        connectWhatsApp(id, socket);
    });
});

// ==========================================================
//  API — LIST CLIENT AKTIF (DASHBOARD)
// ==========================================================
app.get("/api/clients", (req, res) => {
    const list = Object.keys(clients).map((id) => ({
        id,
        connected: true
    }));
    res.json({ success: true, clients: list });
});

// ==========================================================
//  API — SEND TEXT MESSAGE
// ==========================================================
app.post("/api/send-text", async (req, res) => {
    console.log("POST /api/send-text", req.body);

    const { id, phone, message } = req.body;

    if (!id || !phone || !message)
        return res.status(400).json({ success: false, message: "Param kurang" });

    const client = clients[id];
    if (!client)
        return res.status(400).json({ success: false, message: "WA belum connect" });

    let number = phone.replace(/\D/g, "");
    if (number.startsWith("0")) number = "62" + number.substring(1);
    number = number + "@c.us";

    try {
        const sent = await client.sendMessage(number, message);
        res.json({ success: true, id: sent.id.id });
    } catch (err) {
        console.error("ERROR /api/send-text:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================================
//  API — SEND MEDIA (PDF, FOTO, FILE)
// ==========================================================
app.post("/api/send-media", async (req, res) => {
    console.log("POST /api/send-media", {
        id: req.body?.id,
        phone: req.body?.phone,
        filename: req.body?.filename,
        fileDataLength: req.body?.fileData?.length
    });

    const { id, phone, filename, fileData } = req.body;

    if (!id || !phone || !filename || !fileData)
        return res.status(400).json({ success: false, message: "Param kurang" });

    const client = clients[id];
    if (!client)
        return res.status(400).json({ success: false, message: "WA belum connect" });

    let number = phone.replace(/\D/g, "");
    if (number.startsWith("0")) number = "62" + number.substring(1);
    number = number + "@c.us";

    try {
        const media = new MessageMedia("*/*", fileData, filename);
        const sent = await client.sendMessage(number, media);

        res.json({ success: true, messageId: sent.id.id });
    } catch (err) {
        console.error("ERROR /api/send-media:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================================
//  API — BROADCAST TEXT
//  body: { id, message, phones: ["62812xxx","62853xxx", ...] }
// ==========================================================
app.post("/api/broadcast-text", async (req, res) => {
    const { id, message, phones } = req.body;

    if (!id || !message || !Array.isArray(phones) || phones.length === 0) {
        return res.status(400).json({ success: false, message: "Param kurang" });
    }

    const client = clients[id];
    if (!client)
        return res.status(400).json({ success: false, message: "WA belum connect" });

    const results = [];

    for (const raw of phones) {
        let number = (raw || "").toString().replace(/\D/g, "");
        if (!number) continue;
        if (number.startsWith("0")) number = "62" + number.substring(1);
        number = number + "@c.us";

        try {
            const sent = await client.sendMessage(number, message);
            results.push({ phone: raw, success: true, id: sent.id.id });
        } catch (e) {
            results.push({ phone: raw, success: false, error: e.message });
        }
    }

    res.json({ success: true, results });
});

// ==========================================================
//  RUN SERVER
// ==========================================================
server.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log(`📱 QR Scan UI      : http://localhost:${PORT}/qr-scanner.html`);
    console.log(`📁 Send File UI    : http://localhost:${PORT}/send-media.html`);
    console.log(`📊 WA Dashboard UI : http://localhost:${PORT}/wa-dashboard.html`);
});
