# WA Multi-Staff Backend — CLAUDE.md

## Project Overview

WhatsApp multi-staff gateway using **whatsapp-web.js** + **MySQL** (`simrs_wa`).
Tiap staff punya WA client sendiri, diidentifikasi dengan `staff_id` bebas (string).

**Entry point:** `server-new.js` (aktif). `server.js` = versi lama, abaikan.

## Stack

| Layer | Library |
|---|---|
| HTTP | Express 5 |
| Realtime | Socket.IO 4 |
| WA Client | whatsapp-web.js 1.34 + Puppeteer 24 |
| DB | mysql2/promise (pool, `db.js`) |
| QR encode | qrcode |

**Port:** 3030  
**DB:** `localhost` / `root` / no password / database `simrs_wa`

## File Structure

```
server-new.js          # main server (GUNAKAN INI)
server.js              # versi lama — JANGAN dimodifikasi
db.js                  # mysql2 pool ke simrs_wa
qr-scanner.html        # halaman scan QR per staff
wa-dashboard.html      # kirim teks / file / broadcast
send-text.html         # form kirim teks
send-media.html        # form kirim media
wa-clients.html        # list client aktif
outgoing-dashboard.html# log pesan keluar
.wwebjs_auth/          # folder session LocalAuth (session-{staff_id}/)
chats-log.jsonl        # log pesan masuk (append-only)
```

## Database Table: `wa_outgoing`

Kolom penting:

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | PK auto | |
| staff_id | varchar | ID staff WA |
| wa_number | varchar | nomor tanpa `+`, format `628xxx` |
| message | text | isi teks / caption PDF |
| msg_type | enum | `text` / `file` / `pdf` |
| status | enum | `pending` / `sent` / `delivered` / `read` / `failed` / `not_registered` |
| message_id | varchar | WA message ID (dari `sent.id.id`) |
| file_name | varchar | nama file (untuk pdf/file) |
| file_mime | varchar | mime type |
| file_data | longtext | base64 konten file |
| created_at | datetime | |
| updated_at | datetime | |

## In-Memory State

```js
clients = {}   // { [staff_id]: WAClient }  — hilang kalau server restart
qrStore = {}   // { [staff_id]: qr_string } — sementara sampai scan
```

**Penting:** `clients` tidak persisten. Setelah restart, tiap staff harus scan QR lagi KECUALI sudah ada session di `.wwebjs_auth/` (LocalAuth akan restore otomatis tanpa scan ulang).

## API Endpoints

### Immediate Send (langsung kirim, WA client harus aktif)

```
POST /api/send-text
  body: { id, phone, message }
  → cek isRegisteredUser → insert DB pending → sendMessage → update DB sent

POST /api/send-media
  body: { id, phone, filename, fileData }   // fileData = base64 string
  → insert DB pending → sendMessage → update DB sent

POST /api/broadcast-text
  body: { id, message, phones: [] }
  → loop tiap nomor → sendMessage → update DB
```

### Queue (insert DB saja, kirim via run-cron)

```
POST /api/queue-text
  body: { staff_id, wa_number, message }
  → insert wa_outgoing status=pending

POST /api/queue-pdf
  body: { staff_id, wa_number, caption, file_name, file_base64 }
  → strip "data:application/pdf;base64," prefix otomatis
  → insert wa_outgoing status=pending
```

### Queue Processor

```
GET /api/run-cron?token=RAHASIA_CRON_123
  → processQueue(20) — ambil 20 pending, kirim satu per satu
  → update status: sent / failed / not_registered
```

`CRON_TOKEN` baca dari `process.env.CRON_TOKEN`, fallback hardcode `"RAHASIA_CRON_123"`.

### Utilities

```
GET  /api/clients           → list staff_id yang aktif di memory
GET  /api/outgoing          → 200 baris terakhir wa_outgoing ORDER BY id DESC
POST /api/logout            body: { id } → logout + destroy client + hapus session folder
```

## Socket.IO Events

| Direction | Event | Payload |
|---|---|---|
| Client → Server | `check-auth` | `{ id }` |
| Server → Client | `qr:{id}` | data URL PNG |
| Server → Client | `connected:{id}` | `{ status: 'connected' }` |
| Server → Client | `wa-status-update` | `{ messageId, status }` / `{ dbId, messageId, status }` |
| Server → Client | `wa-new-outgoing` | row baru |
| Server → Client | `wa-client-logout` | `{ id }` |

## Phone Number Normalization

```js
number = phone.replace(/\D/g, '')
if (number.startsWith('0')) number = '62' + number.substring(1)
waId = number + '@c.us'
```

Fungsi `normalizePhone()` digunakan di `processQueue`, logika sama.

## Message ACK → DB Status

```
ack=1 → 'sent'
ack=2 → 'delivered'
ack=3 → 'read'
```

Update via `message_ack` event, match by `message_id` di DB.

## Feature Flags (server-new.js)

```js
AUTO_REPLY_ENABLED   = false   // balas otomatis teks statis
AUTO_BOT_AI_ENABLED  = false   // integrasi AI (stub kosong)
```

## Auto-Reconnect

Saat `disconnected` event: `client.destroy()` → `delete clients[id]` → `setTimeout(connectWhatsApp, 1500)`.

## Run

```bash
node server-new.js
```

Buka `http://localhost:3030/qr-scanner.html` untuk connect tiap staff.

## Catatan Penting

- **Jangan edit `server.js`** — sudah diganti `server-new.js`
- `file_data` di DB bisa sangat besar (base64 PDF). Jangan SELECT * untuk row PDF kalau tidak perlu.
- `clients` object in-memory: kalau server restart, queue pending tidak otomatis jalan sampai ada `check-auth` dari frontend atau ada trigger manual.
- CRON_TOKEN hardcode sebagai fallback — set `CRON_TOKEN` di environment untuk production.
