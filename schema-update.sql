-- ============================================================
--  WA Gateway — Schema Update
--  Jalankan sekali pada database simrs_wa
--  Kalau kolom sudah ada → error "Duplicate column name" → abaikan, lanjut
-- ============================================================

-- Update wa_outgoing: tambah kolom baru (jalankan satu per satu)
ALTER TABLE wa_outgoing ADD COLUMN retry_count INT DEFAULT 0;
ALTER TABLE wa_outgoing ADD COLUMN caption TEXT NULL;
ALTER TABLE wa_outgoing ADD COLUMN scheduled_at DATETIME NULL;

-- Index untuk scheduled messages (opsional, percepat query cron)
CREATE INDEX idx_outgoing_status_scheduled ON wa_outgoing (status, scheduled_at);

-- Tabel pesan masuk
CREATE TABLE IF NOT EXISTS wa_incoming (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  staff_id   VARCHAR(100) NOT NULL,
  from_number VARCHAR(50),
  body       TEXT,
  msg_type   VARCHAR(30) DEFAULT 'chat',
  has_media  TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT NOW()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabel template pesan
CREATE TABLE IF NOT EXISTS wa_templates (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  content    TEXT NOT NULL,
  created_at DATETIME DEFAULT NOW()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
