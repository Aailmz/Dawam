const Database = require('better-sqlite3');
const path = require('path');

// DAWAM_DB_PATH hanya untuk test/dev (mis. ':memory:'); default tetap dawam.db di folder project.
const db = new Database(process.env.DAWAM_DB_PATH || path.join(__dirname, 'dawam.db'));
// Tunggu (bukan langsung error "database is locked") kalau skrip lain sedang menulis DB.
db.pragma('busy_timeout = 5000');
// WAL opt-in saja (DAWAM_DB_WAL=1). Default mati: mode journal DB di VPS tidak berubah, dan backup
// dengan menyalin dawam.db saja tetap lengkap. Kalau diaktifkan, backup harus ikut menyalin -wal/-shm.
if (process.env.DAWAM_DB_WAL === '1') db.pragma('journal_mode = WAL');

// ========== TANGGAL (WIB) ==========
// SEMUA tanggal "hari ini" di aplikasi WAJIB lewat helper ini, bukan
// new Date().toISOString().slice(0, 10) -- itu tanggal UTC, jadi laporan antara jam
// 00:00-07:00 WIB tercatat ke tanggal kemarin dan tidak terhitung di rekap harian.
const ZONA_WAKTU_APP = 'Asia/Jakarta';
const formatterTanggal = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_WAKTU_APP,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// 'YYYY-MM-DD' menurut WIB. date opsional (default sekarang).
function tanggalISO(date = new Date()) {
  return formatterTanggal.format(date);
}

function tanggalHariIniISO() {
  return tanggalISO(new Date());
}

// Tanggal N hari sebelum hari ini (WIB), format 'YYYY-MM-DD'.
function tanggalMundurISO(jumlahHari) {
  return tanggalISO(new Date(Date.now() - jumlahHari * 24 * 60 * 60 * 1000));
}

// Selisih hari kalender antara dua string 'YYYY-MM-DD' (akhir - awal), tanpa efek timezone.
function selisihHariISO(awalISO, akhirISO) {
  const [ya, ma, da] = awalISO.split('-').map(Number);
  const [yb, mb, dbb] = akhirISO.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, dbb) - Date.UTC(ya, ma - 1, da)) / (24 * 60 * 60 * 1000));
}

// ========== SKEMA ==========

db.exec(`
  CREATE TABLE IF NOT EXISTS bacaan (
    kode TEXT PRIMARY KEY,
    urutan INTEGER NOT NULL UNIQUE,
    halaman INTEGER NOT NULL,
    bagian TEXT NOT NULL,
    juz INTEGER NOT NULL,
    surat_ayat TEXT NOT NULL,
    surat_mulai TEXT NOT NULL,
    ayat_mulai INTEGER NOT NULL,
    surat_selesai TEXT NOT NULL,
    ayat_selesai INTEGER NOT NULL,
    ayat_terpotong INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    jid TEXT PRIMARY KEY,
    last_sent_id INTEGER DEFAULT 0,
    state TEXT DEFAULT 'IDLE',
    is_registered INTEGER DEFAULT 0,
    name TEXT,
    location TEXT
  )
`);

// Grup: MURNI ruang sosial (lapor progress, saling semangatin, ngobrol).
// Bacaan (gambar Arab/terjemah) TIDAK PERNAH dikirim ke grup -- selalu personal.
// Makanya tabel ini TIDAK punya kolom last_sent_bacaan_id / tanggal_mulai_baca
// seperti tabel users; progress tetap 100% bersumber dari tabel users per anggota.
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    jid TEXT PRIMARY KEY,
    nama TEXT,
    is_aktif INTEGER DEFAULT 0,
    state TEXT DEFAULT 'IDLE',
    waktu_motivasi_terakhir TEXT   -- dipakai buat jarak-in broadcast ajakan ngobrol ringan
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS group_members (
    group_jid TEXT NOT NULL,
    user_jid TEXT NOT NULL,
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_jid, user_jid)
  )
`);

// Log ringan aktivitas yang dilaporkan/dideteksi di grup, dipakai buat rekap sederhana
// ("siapa aja yang cerita progress minggu ini"). Bukan sumber kebenaran progress --
// sumber kebenaran progress tetap tabel users.
db.exec(`
  CREATE TABLE IF NOT EXISTS group_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid TEXT NOT NULL,
    user_jid TEXT NOT NULL,
    jenis TEXT NOT NULL,          -- 'LAPOR_PROGRESS' | 'MOTIVASI_DIKIRIM' | 'TANYA_PROGRESS'
    catatan TEXT,                 -- ringkasan singkat opsional
    waktu TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Histori chat untuk agent. Satu tabel untuk personal DAN grup:
// - personal: chat_jid = jid user
// - grup: chat_jid = jid grup, sender_jid = siapa yang bicara
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    sender_jid TEXT,
    role TEXT NOT NULL,        -- 'user' | 'assistant'
    content TEXT NOT NULL,
    waktu TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_history_chat ON chat_history (chat_jid, id)`);


// Log harian per-user, SATU baris per hari per user (upsert), dipakai untuk:
// - jawab "kemarin baca apa" / histori yang bisa ditanya balik (bukan cuma posisi terakhir)
// - basis agregat rekap mingguan
// - deteksi siapa yang DI_BAWAH_PACE pas Isya (poin 1 lelang)
db.exec(`
  CREATE TABLE IF NOT EXISTS log_bacaan_harian (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL,
    tanggal TEXT NOT NULL,              -- YYYY-MM-DD
    bacaan_id_awal INTEGER,             -- id bacaan pertama yang dikirim hari itu
    bacaan_id_akhir INTEGER,            -- id bacaan terakhir yang dikirim hari itu
    surat_ayat_akhir TEXT,              -- label terakhir hari itu, buat ditampilkan tanpa join lagi
    jumlah_kartu INTEGER DEFAULT 0,     -- berapa kartu dikirim hari itu
    status_pace_akhir TEXT,             -- snapshot status pace di akhir hari itu (boleh null)
    UNIQUE(user_jid, tanggal)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_log_bacaan_user_tgl ON log_bacaan_harian (user_jid, tanggal)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_berhenti (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL,
    isi_feedback TEXT,          -- boleh null kalau user skip/tidak mau kasih alasan
    waktu TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// ========== POWER USER (feedback ke tim development) ==========
// Hanya tabel BARU (IF NOT EXISTS): aman dijalankan di DB produksi, tidak menyentuh data lama.
db.exec(`
  CREATE TABLE IF NOT EXISTS power_users (
    jid TEXT PRIMARY KEY,
    ditambahkan_oleh TEXT,
    waktu TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_power (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL,
    isi_asli TEXT NOT NULL,           -- kalimat user apa adanya (tidak pernah ditimpa)
    isi_rapi TEXT,                    -- versi rapi buat operator, diisi saat digest dibuat
    kategori TEXT NOT NULL DEFAULT 'LAIN',   -- BUG | SARAN | KELUHAN | LAIN
    status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | TERKIRIM | SELESAI
    tanggal TEXT NOT NULL,            -- YYYY-MM-DD WIB, buat batas harian
    waktu TEXT DEFAULT CURRENT_TIMESTAMP,
    dikirim_pada TEXT,                -- masuk digest operator
    selesai_pada TEXT,
    catatan_selesai TEXT,
    user_diberitahu_pada TEXT         -- user sudah dikabari kalau feedback-nya selesai
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_power_status ON feedback_power (status, id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_power_user ON feedback_power (user_jid, id)`);

// Satu baris per hari digest berhasil dikirim, dipakai untuk "susul" kalau bot mati pas jam kirim.
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_digest_log (
    tanggal TEXT PRIMARY KEY,
    waktu TEXT DEFAULT CURRENT_TIMESTAMP,
    jumlah INTEGER
  )
`);

// Migrasi: tabel 'ayat' (generic image, Phase 1) sudah digantikan tabel 'bacaan'.
const tabelLamaMasihAda = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ayat'`)
  .get();
if (tabelLamaMasihAda) {
  db.exec(`DROP TABLE ayat`);
  console.log('✅ Tabel "ayat" (lama, Phase 1) dihapus — digantikan tabel "bacaan".');
}

// Migrasi: skema 'bacaan' lama (id integer, per waktu sholat) sudah digantikan
// skema baru berbasis kode kartu mushaf (kode text, per halaman mushaf Madinah).
const kolomBacaanSaatIni = db.prepare(`PRAGMA table_info(bacaan)`).all().map((k) => k.name);
if (kolomBacaanSaatIni.includes('id') || kolomBacaanSaatIni.includes('hari_global')) {
  db.exec(`DROP TABLE bacaan`);
  console.log('✅ Tabel "bacaan" skema lama (per id/waktu sholat) dihapus — digantikan skema kode kartu baru.');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bacaan (
      kode TEXT PRIMARY KEY,
      urutan INTEGER NOT NULL UNIQUE,
      halaman INTEGER NOT NULL,
      bagian TEXT NOT NULL,
      juz INTEGER NOT NULL,
      surat_ayat TEXT NOT NULL,
      surat_mulai TEXT NOT NULL,
      ayat_mulai INTEGER NOT NULL,
      surat_selesai TEXT NOT NULL,
      ayat_selesai INTEGER NOT NULL,
      ayat_terpotong INTEGER DEFAULT 0
    )
  `);
}

// Migrasi kolom baru di 'users'. SQLite tidak punya "ADD COLUMN IF NOT EXISTS",
// jadi cek dulu kolom yang sudah ada sebelum ALTER.
function tambahKolomJikaBelumAda(namaTabel, namaKolom, definisiKolom) {
  const kolomSaatIni = db.prepare(`PRAGMA table_info(${namaTabel})`).all().map((k) => k.name);
  if (!kolomSaatIni.includes(namaKolom)) {
    db.exec(`ALTER TABLE ${namaTabel} ADD COLUMN ${namaKolom} ${definisiKolom}`);
    console.log(`✅ Kolom ${namaTabel}.${namaKolom} ditambahkan.`);
  }
}

tambahKolomJikaBelumAda('users', 'gender', 'TEXT');
tambahKolomJikaBelumAda('users', 'target_juz_per_hari', 'TEXT');
tambahKolomJikaBelumAda('users', 'motivasi_personal', 'TEXT');
tambahKolomJikaBelumAda('users', 'mulai_surat', 'TEXT');
tambahKolomJikaBelumAda('users', 'last_sent_bacaan_id', 'INTEGER DEFAULT 0');
tambahKolomJikaBelumAda('users', 'tanggal_mulai_baca', 'TEXT');
tambahKolomJikaBelumAda('users', 'consecutive_no_response', 'INTEGER DEFAULT 0');
tambahKolomJikaBelumAda('users', 'mode_baca_arab_saja', 'INTEGER DEFAULT 1');
tambahKolomJikaBelumAda('users', 'waktu_tawaran_terakhir', 'TEXT');
// Grup sosial yang jadi "rumah" user ini buat lapor progress (opsional, boleh null).
// Satu user hanya terhubung ke satu grup sosial primary untuk kesederhanaan prototype.
tambahKolomJikaBelumAda('users', 'group_sosial_jid', 'TEXT');
tambahKolomJikaBelumAda('users', 'sudah_lapor_sesi_ini', 'INTEGER DEFAULT 0');
tambahKolomJikaBelumAda('users', 'start_bacaan_id', 'INTEGER DEFAULT 0');
tambahKolomJikaBelumAda('users', 'tanggal_terakhir_baca', 'TEXT');
// Posisi kedua khusus Jumat Al-Kahfi (poin 3), independen dari last_sent_bacaan_id utama.
tambahKolomJikaBelumAda('users', 'last_sent_alkahfi_id', 'INTEGER DEFAULT 0');
tambahKolomJikaBelumAda('users', 'tanggal_terakhir_alkahfi', 'TEXT');
// Stop/resume subscription -- TERPISAH dari is_registered supaya data (progress,
// preferensi, nama, dll) tidak hilang saat user berhenti sementara lalu balik lagi.
// is_registered tetap artinya "pernah onboarding", is_active artinya "lagi nerima layanan sekarang".
tambahKolomJikaBelumAda('users', 'is_active', 'INTEGER DEFAULT 1');
tambahKolomJikaBelumAda('users', 'waktu_berhenti_terakhir', 'TEXT');
// Toggle
tambahKolomJikaBelumAda('users', 'reminder_sholat_aktif', 'INTEGER DEFAULT 1');
tambahKolomJikaBelumAda('users', 'tawaran_tilawah_aktif', 'INTEGER DEFAULT 1');
tambahKolomJikaBelumAda('users', 'tawaran_alkahfi_aktif', 'INTEGER DEFAULT 1');
tambahKolomJikaBelumAda('users', 'reminder_jumat_laki_aktif', 'INTEGER DEFAULT 1');
tambahKolomJikaBelumAda('users', 'bentuk_bacaan', "TEXT DEFAULT 'kartu'"); // 'kartu' | 'reminder'

// Migrasi (idempotent): user yang cuma lapor manual tidak pernah dapat tanggal_mulai_baca
// (dulu cuma diisi saat kirim kartu), sehingga hitungSisaProgressUser menganggap mereka
// "tanpa target" dan persen rekap harian-nya tidak pernah terhitung. Isi dari tanggal
// log pertama mereka.
const jumlahDiperbaiki = db
  .prepare(`
    UPDATE users
    SET tanggal_mulai_baca = (
      SELECT MIN(l.tanggal) FROM log_bacaan_harian l WHERE l.user_jid = users.jid
    )
    WHERE (tanggal_mulai_baca IS NULL OR tanggal_mulai_baca = '')
      AND EXISTS (SELECT 1 FROM log_bacaan_harian l WHERE l.user_jid = users.jid)
  `)
  .run().changes;
if (jumlahDiperbaiki > 0) {
  console.log(`✅ Migrasi: tanggal_mulai_baca diisi untuk ${jumlahDiperbaiki} user dari log bacaan pertama mereka.`);
}

// ========== BACAAN ==========

function insertBacaan(row) {
  const stmt = db.prepare(`
    INSERT INTO bacaan (
      kode, urutan, halaman, bagian, juz, surat_ayat,
      surat_mulai, ayat_mulai, surat_selesai, ayat_selesai, ayat_terpotong
    )
    VALUES (
      @kode, @urutan, @halaman, @bagian, @juz, @surat_ayat,
      @surat_mulai, @ayat_mulai, @surat_selesai, @ayat_selesai, @ayat_terpotong
    )
  `);
  return stmt.run(row);
}

function countBacaan() {
  const row = db.prepare('SELECT COUNT(*) as total FROM bacaan').get();
  return row.total;
}

const TOTAL_KARTU = () => countBacaan(); // dipakai untuk wraparound, dihitung dari data, bukan hardcode

function getBacaanByKode(kode) {
  return db.prepare('SELECT * FROM bacaan WHERE kode = ?').get(kode);
}

function getBacaanByUrutan(urutan) {
  return db.prepare('SELECT * FROM bacaan WHERE urutan = ?').get(urutan);
}

// Kartu pertama (urutan=1) dan kartu terakhir (urutan=TOTAL_KARTU), dipakai untuk wraparound.
function getUrutanMin() {
  return db.prepare('SELECT MIN(urutan) as m FROM bacaan').get().m;
}
function getUrutanMax() {
  return db.prepare('SELECT MAX(urutan) as m FROM bacaan').get().m;
}

// Path gambar digenerate dari kode -- tidak disimpan di db, karena arab & terjemah
// cuma beda prefix nama file (kartu-003a.jpg vs terjemahan-003a.jpg).
function normalisasiKodeUntukFilename(kode) {
  // File gambar selalu pakai angka 3-digit zero-padded (001, 014, 114, dst),
  // sementara kolom "kode" di DB disimpan tanpa padding (1, 14, 114). Fungsi ini
  // menyamakan representasi kode ke format filename yang sebenarnya dipakai di disk.
  const match = kode.match(/^(\d+)([a-z]*)$/);
  if (!match) return kode; // format tidak dikenali, pakai apa adanya
  const [, angka, huruf] = match;
  return angka.padStart(3, '0') + huruf;
}

function pathArabDariKode(kode) {
  return `images/kartu-${normalisasiKodeUntukFilename(kode)}.jpg`;
}
function pathIndoDariKode(kode) {
  return `images/terjemahan-${normalisasiKodeUntukFilename(kode)}.jpg`;
}

function cariBacaanBySuratLike(suratKeyword) {
  return db
    .prepare('SELECT * FROM bacaan WHERE surat_ayat LIKE ? ORDER BY urutan ASC LIMIT 1')
    .get(`%${suratKeyword}%`);
}

// Cari card yang MENGANDUNG ayat tertentu dari suatu surat -- dipakai lapor_bacaan_by_ayat.
// Karena satu card bisa mencakup rentang ayat (ayat_mulai..ayat_selesai), dan juga bisa
// span lintas surat (surat_mulai != surat_selesai), pencarian dicoba dengan urutan prioritas:
// 1. Surat PERSIS cocok di salah satu ujung (mulai/selesai) DAN ayat ada dalam rentang card itu.
// 2. Kalau tidak ketemu rentang yang pas (misal ayat disebut user meleset dikit dari rentang
//    yang terdata), fallback ke card dengan surat cocok yang ayat_mulai-nya PALING DEKAT
//    (<=) ke ayat yang disebut -- supaya tetap dapat posisi yang masuk akal.
function cariBacaanBySuratDanAyat(namaSurat, nomorAyat) {
  const kandidatTepat = db
    .prepare(`
      SELECT * FROM bacaan
      WHERE (
        (surat_mulai LIKE ? AND ? >= ayat_mulai AND (surat_mulai != surat_selesai OR ? <= ayat_selesai))
        OR
        (surat_selesai LIKE ? AND surat_mulai != surat_selesai AND ? <= ayat_selesai)
      )
      ORDER BY urutan ASC
      LIMIT 1
    `)
    .get(`%${namaSurat}%`, nomorAyat, nomorAyat, `%${namaSurat}%`, nomorAyat);

  if (kandidatTepat) return kandidatTepat;

  // Fallback: surat cocok, ambil card dengan ayat_mulai terbesar yang masih <= nomorAyat
  // (artinya posisi user ada di card ini atau beberapa card setelahnya yang belum tercatat).
  const fallback = db
    .prepare(`
      SELECT * FROM bacaan
      WHERE surat_mulai LIKE ? AND ayat_mulai <= ?
      ORDER BY ayat_mulai DESC, urutan DESC
      LIMIT 1
    `)
    .get(`%${namaSurat}%`, nomorAyat);

  return fallback || null;
}

// Jumlah kartu dalam satu juz -- dipakai untuk hitung pace dinamis (juz tidak seragam
// jumlah kartunya di skema baru, beda dari skema lama yang fixed 30/juz).
function hitungJumlahKartuDalamJuz(juz) {
  return db.prepare('SELECT COUNT(*) as total FROM bacaan WHERE juz = ?').get(juz).total;
}

// ========== USERS ==========

function getOrCreateUser(jid) {
  let user = db.prepare('SELECT * FROM users WHERE jid = ?').get(jid);
  if (!user) {
    db.prepare(
      'INSERT INTO users (jid, last_sent_id, state, is_registered) VALUES (?, 0, ?, 0)'
    ).run(jid, 'IDLE');
    user = db.prepare('SELECT * FROM users WHERE jid = ?').get(jid);
  }
  return user;
}

function getUser(jid) {
  return getOrCreateUser(jid);
}

function isUserRegistered(jid) {
  const user = getOrCreateUser(jid);
  return user.is_registered === 1;
}

function registerUser(jid) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET is_registered = 1 WHERE jid = ?').run(jid);
}

function setUserName(jid, name) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET name = ? WHERE jid = ?').run(name, jid);
}

function setUserLocation(jid, location) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET location = ? WHERE jid = ?').run(location, jid);
}

function getUserName(jid) {
  const user = getOrCreateUser(jid);
  return user.name;
}

function setUserState(jid, state) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET state = ? WHERE jid = ?').run(state, jid);
}

function getUserState(jid) {
  const user = getOrCreateUser(jid);
  return user.state;
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

function setUserGender(jid, gender) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET gender = ? WHERE jid = ?').run(gender, jid);
}

function setUserTarget(jid, targetJuzPerHari) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET target_juz_per_hari = ? WHERE jid = ?').run(targetJuzPerHari, jid);
}

function setUserMotivasi(jid, motivasi) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET motivasi_personal = ? WHERE jid = ?').run(motivasi, jid);
}

function setUserMulaiSurat(jid, mulaiSurat) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET mulai_surat = ? WHERE jid = ?').run(mulaiSurat, jid);
}

function updateLastSentBacaanId(jid, newId) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET last_sent_bacaan_id = ? WHERE jid = ?').run(newId, jid);
}

function setTanggalMulaiBaca(jid, tanggalISO) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET tanggal_mulai_baca = ? WHERE jid = ?').run(tanggalISO, jid);
}

function setStartBacaanId(jid, id) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET start_bacaan_id = ? WHERE jid = ?').run(id, jid);
}

function setTanggalTerakhirBaca(jid, tanggalISO) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET tanggal_terakhir_baca = ? WHERE jid = ?').run(tanggalISO, jid);
}

function incrementNoResponse(jid) {
  getOrCreateUser(jid);
  db.prepare(
    'UPDATE users SET consecutive_no_response = consecutive_no_response + 1 WHERE jid = ?'
  ).run(jid);
}

function resetNoResponse(jid) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET consecutive_no_response = 0 WHERE jid = ?').run(jid);
}

function setModeArabSaja(jid, aktif) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET mode_baca_arab_saja = ? WHERE jid = ?').run(aktif ? 1 : 0, jid);
}

function setWaktuTawaranTerakhir(jid, tanggalISO) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET waktu_tawaran_terakhir = ? WHERE jid = ?').run(tanggalISO, jid);
}

function setGroupSosialUser(jid, groupJid) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET group_sosial_jid = ? WHERE jid = ?').run(groupJid, jid);
}

function setSudahLaporSesiIni(jid, sudah) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET sudah_lapor_sesi_ini = ? WHERE jid = ?').run(sudah ? 1 : 0, jid);
}

// Set grup sosial HANYA kalau user belum punya grup sosial sama sekali (auto-link pertama kali).
// Return true kalau berhasil di-set, false kalau sudah ada grup sosial sebelumnya (tidak ditimpa).
function setGroupSosialJikaBelumAda(jid, groupJid) {
  const user = getOrCreateUser(jid);
  if (user.group_sosial_jid) return false;
  db.prepare('UPDATE users SET group_sosial_jid = ? WHERE jid = ?').run(groupJid, jid);
  return true;
}

// ========== STOP / RESUME SUBSCRIPTION ==========

function isUserActive(jid) {
  const user = getOrCreateUser(jid);
  // User lama sebelum kolom ini ada defaultnya 1 (DEFAULT 1 di ALTER), jadi aman.
  return user.is_active === 1;
}

function nonaktifkanUser(jid) {
  getOrCreateUser(jid);
  db.prepare(
    'UPDATE users SET is_active = 0, waktu_berhenti_terakhir = ? WHERE jid = ?'
  ).run(new Date().toISOString(), jid);
}

function aktifkanKembaliUser(jid) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET is_active = 1 WHERE jid = ?').run(jid);
}

function simpanFeedbackBerhenti(jid, isiFeedback) {
  db.prepare(
    'INSERT INTO feedback_berhenti (user_jid, isi_feedback) VALUES (?, ?)'
  ).run(jid, isiFeedback || null);
}

// ========== ONBOARDING CONVERSATIONAL (phase 2) ==========

const FIELD_ONBOARDING_WAJIB = ['name', 'location', 'gender', 'target_juz_per_hari', 'motivasi_personal', 'mulai_surat'];
// mulai_surat sengaja TIDAK wajib -- kalau kosong, default mulai dari awal.


// Satu-satunya sumber kebenaran untuk opsi target yang valid -- dipakai di tools.js,
// groq.js (prompt extractDataOnboarding/parseTargetDariJawaban), dan index.js (fallback teks).
// JANGAN hardcode ulang list ini di tempat lain.
const OPSI_TARGET_VALID = ['12', '6', '3', '1'];

function isTargetValid(target) {
  return OPSI_TARGET_VALID.includes(target);
}

function getFieldOnboardingKosong(jid) {
  const user = getUser(jid);
  return FIELD_ONBOARDING_WAJIB.filter((f) => !user[f]);
}

function isOnboardingLengkap(jid) {
  return getFieldOnboardingKosong(jid).length === 0;
}

function updateUserFields(jid, data) {
  getOrCreateUser(jid);
  const kolomValid = [
    'name', 'location', 'gender', 'target_juz_per_hari', 'motivasi_personal', 'mulai_surat',
    'reminder_sholat_aktif', 'tawaran_tilawah_aktif', 'tawaran_alkahfi_aktif',
    'reminder_jumat_laki_aktif', 'bentuk_bacaan',
  ];
  // Rapikan input teks dari AI sebelum divalidasi: nama/lokasi satu baris & dibatasi panjangnya
  // (nilai ini dimasukkan ke prompt), gender dinormalkan ke huruf besar.
  const rapikan = ([k, v]) => {
    if (typeof v !== 'string') return [k, v];
    if (k === 'name' || k === 'location') return [k, v.replace(/\s+/g, ' ').trim().slice(0, 60)];
    if (k === 'gender') return [k, v.trim().toUpperCase()];
    return [k, v];
  };
  const entries = Object.entries(data || {}).map(rapikan).filter(([k, v]) => {
    if (!kolomValid.includes(k) || v === null || v === undefined || v === '') return false;
    if (k === 'gender' && v !== 'L' && v !== 'P') {
      console.log(`⚠️  gender="${v}" tidak valid (harus L/P), diabaikan.`);
      return false;
    }
    if (k === 'target_juz_per_hari' && !isTargetValid(v)) {
      console.log(`⚠️  target_juz_per_hari="${v}" tidak valid, diabaikan.`);
      return false;
    }
    if (k === 'bentuk_bacaan' && !['kartu', 'reminder'].includes(v)) {
      console.log(`⚠️  bentuk_bacaan="${v}" tidak valid, diabaikan.`);
      return false;
    }
    return true;
  });
  if (entries.length === 0) return;

  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE users SET ${setClause} WHERE jid = ?`).run(...values, jid);
}

// Hitung hari berjalan sejak mulai baca (dipakai tool get_progress_user)
function hitungHariBerjalanUser(jid) {
  const user = getUser(jid);
  if (!user.tanggal_mulai_baca) return null;
  return selisihHariISO(user.tanggal_mulai_baca, tanggalHariIniISO()) + 1;
}

// Pastikan tanggal_mulai_baca terisi. Dipanggil dari SEMUA jalur pencatatan bacaan
// (kartu maupun lapor manual) supaya user yang cuma lapor manual tetap punya target.
function pastikanTanggalMulaiBaca(jid, tanggalISOMulai = tanggalHariIniISO()) {
  const user = getUser(jid);
  if (user && !user.tanggal_mulai_baca) {
    setTanggalMulaiBaca(jid, tanggalISOMulai);
  }
}

function totalKartuKeseluruhan() {
  return countBacaan(); // sekitar 1.808, dihitung dari data riil, bukan hardcode
}
// Rata-rata kartu/juz dipakai HANYA sebagai estimasi target harian (lihat catatan
// di hitungSisaProgressUser) -- jumlah kartu per juz di skema baru TIDAK seragam.
function rataKartuPerJuz() {
  return totalKartuKeseluruhan() / 30;
}

// ===== Satuan: DB menyimpan KARTU (1 halaman mushaf = ~3 kartu). Semua angka yang ditampilkan ke
// user / AI dalam HALAMAN mushaf, supaya sama dengan yang dia lihat di mushaf fisik/app. =====
const JUMLAH_HALAMAN_MUSHAF = 604;

function kartuPerHalaman() {
  const total = totalKartuKeseluruhan();
  return total > 0 ? total / JUMLAH_HALAMAN_MUSHAF : 1;
}

function kartuKeHalaman(kartu) {
  return kartu / kartuPerHalaman();
}

// Laporan manual dari user dalam halaman -> kartu (minimal 1).
function halamanKeKartu(halaman) {
  return Math.max(1, Math.round(halaman * kartuPerHalaman()));
}

// 1 desimal kalau kecil (1.3), bulat kalau >= 10 (21), supaya enak dibaca di chat.
function bulatkanHalaman(h) {
  return h >= 10 ? Math.round(h) : Math.round(h * 10) / 10;
}

// Input dalam KARTU. Output: kartu (bilangan bulat) kalau < 1 juz, juz (bulat) kalau lebih.
// Satuan tampilan ke user = KARTU, bukan halaman mushaf (user membaca kartu Dawam).
function formatSelisihUntukTampilan(selisihKartuAbs) {
  if (selisihKartuAbs < rataKartuPerJuz()) {
    return { satuan: 'kartu', nilai: Math.round(selisihKartuAbs) };
  }
  const juz = Math.round(selisihKartuAbs / rataKartuPerJuz());
  return { satuan: 'juz', nilai: juz };
}

// Hitung halaman yang sudah ditempuh dari titik start, MEMPERHITUNGKAN wraparound.
// Kalau posisi sekarang masih di depan start (belum pernah wrap), ini sama kayak
// pengurangan biasa. Tapi kalau user udah lewat id 900 dan muter balik ke id kecil
// (misal start di juz 30 ~id870, sekarang udah di id50 lagi), pengurangan biasa
// bakal jadi negatif/salah -- padahal user udah baca (900-870)+50 halaman.
function hitungHalamanDitempuhDenganWrap(startBacaanId, posisiSekarangId) {
  if (posisiSekarangId >= startBacaanId) {
    return posisiSekarangId - startBacaanId;
  }
  return (totalKartuKeseluruhan() - startBacaanId) + posisiSekarangId;
}

// Cek apakah user sudah khatam (muter penuh kembali ke/lewat titik start-nya sendiri).
// targetNextId = id yang AKAN dikirim berikutnya (sebelum wrap-check di pemanggil).
function sudahKhatamSetelahWrap(startBacaanId, idSebelumWrap, idSetelahWrap) {
  // Khatam terjadi kalau pengiriman kali ini melewati batas 900->1 (ada wrap)
  // DAN titik setelah wrap sudah mencapai/melewati start point.
  const adaWrap = idSebelumWrap > idSetelahWrap;
  if (!adaWrap) return false;
  return idSetelahWrap >= startBacaanId;
}

// Khatam = jarak tempuh dari titik start BARU melewati satu putaran penuh pada pengiriman ini.
// Bekerja untuk start di mana pun (sudahKhatamSetelahWrap hanya benar untuk start di awal mushaf).
function sudahKhatamSetelahKirim(startBacaanId, posisiSebelum, posisiSesudah) {
  const total = totalKartuKeseluruhan();
  if (!total || posisiSebelum === posisiSesudah) return false;
  const jarakSebelum = hitungHalamanDitempuhDenganWrap(startBacaanId, posisiSebelum);
  // Kembali tepat ke titik start berarti satu putaran penuh (bukan 0).
  const jarakSesudah = posisiSesudah === startBacaanId ? total : hitungHalamanDitempuhDenganWrap(startBacaanId, posisiSesudah);
  return jarakSebelum < total && jarakSesudah >= total;
}

// Target harian (kartu/hari) dari pilihan "1 juz per N hari". null kalau target tidak valid.
function hitungTargetHarian(targetJuzPerHari) {
  if (!isTargetValid(String(targetJuzPerHari))) return null;
  return Math.round(rataKartuPerJuz() / Number(targetJuzPerHari));
}

// Basis perhitungan: JARAK YANG SUDAH DITEMPUH dari titik mulai (start_bacaan_id),
// BUKAN posisi absolut di buku. User bisa mulai dari surat manapun (tidak selalu
// Al-Fatihah) -- posisi tinggi tidak berarti progress besar kalau start-nya juga tinggi.
function hitungSisaProgressUser(jid) {
  const user = getUser(jid);
  const bacaan = getBacaanByUrutan(user.last_sent_bacaan_id);
  const juzSekarang = bacaan?.juz ?? null;
  const posisiSekarang = user.last_sent_bacaan_id || 0;
  const startBacaanId = user.start_bacaan_id || 0;
  const halamanDitempuh = hitungHalamanDitempuhDenganWrap(startBacaanId, posisiSekarang);

  const hariIniISOAwal = tanggalHariIniISO();
  if (!user.target_juz_per_hari || !user.tanggal_mulai_baca) {
    return {
      ada_target: false,
      target_juz_per_hari: user.target_juz_per_hari || null,
      juz_sekarang: juzSekarang,
      kartu_posisi_sekarang: posisiSekarang,
      kartu_ditempuh: halamanDitempuh,
      total_kartu_keseluruhan: totalKartuKeseluruhan(),
      sudah_baca_hari_ini: user.tanggal_terakhir_baca === hariIniISOAwal,
      // null = memang tidak relevan dihitung (belum ada target/belum mulai), BUKAN 0%.
      // Konsumen (rekap) WAJIB tampilkan field ini -- null ditampilkan sebagai "-" bukan di-skip.
      persen_pace: null,
    };
  }

  const hariBerjalan = hitungHariBerjalanUser(jid);

  let halamanPerHari;
  if (user.target_juz_per_hari === '12') halamanPerHari = rataKartuPerJuz() / 12;
  else if (user.target_juz_per_hari === '6') halamanPerHari = rataKartuPerJuz() / 6;
  else if (user.target_juz_per_hari === '3') halamanPerHari = rataKartuPerJuz() / 3;
  else if (user.target_juz_per_hari === '1') halamanPerHari = rataKartuPerJuz() / 1;
  else {
    return {
      ada_target: false,
      target_juz_per_hari: user.target_juz_per_hari,
      juz_sekarang: juzSekarang,
      kartu_posisi_sekarang: posisiSekarang,
      kartu_ditempuh: halamanDitempuh,
      total_kartu_keseluruhan: totalKartuKeseluruhan(),
    };
  }

  // Target HARIAN murni -- tidak dikali hariBerjalan, tidak bawa-bawa defisit hari
  // sebelumnya. Dibandingkan dengan halaman yang ditempuh HARI INI SAJA, bukan
  // halamanDitempuh total sejak mulai.
  const halamanTarget = Math.round(halamanPerHari);
  const logHariIni = getLogBacaanHarianByTanggal(jid, tanggalHariIniISO());
  const halamanDitempuhHariIni = logHariIni?.jumlah_kartu || 0;
  const selisihHalaman = halamanTarget - halamanDitempuhHariIni;

  let status;
  if (selisihHalaman > 0) status = 'DI_BAWAH_PACE';
  else if (selisihHalaman < 0) status = 'SUDAH_CAPAI_PACE';
  else status = 'PAS_PACE';

  const tampilan = formatSelisihUntukTampilan(Math.abs(selisihHalaman));
  // Cap ke 100% begitu capai/lewat target hari ini -- user yang jauh melampaui target
  // (misal baca banyak sekaligus) tetap ditampilkan 100%, bukan 130%/200% dst, karena
  // "progress hari ini" secara konsep selesai begitu nyampe 100%, sisanya kelebihan.
  const persenPaceMentah = halamanTarget > 0 ? Math.round((halamanDitempuhHariIni / halamanTarget) * 100) : null;
  const persenPace = persenPaceMentah !== null
    ? (status === 'SUDAH_CAPAI_PACE' || status === 'PAS_PACE' ? 100 : persenPaceMentah)
    : null;
  const sudahBacaHariIni = user.tanggal_terakhir_baca === tanggalHariIniISO();

  return {
    ada_target: true,
    target_juz_per_hari: user.target_juz_per_hari,
    juz_sekarang: juzSekarang,
    // Semua angka progres dalam KARTU (bilangan bulat), sama dengan yang dibaca user.
    kartu_posisi_sekarang: posisiSekarang,
    kartu_ditempuh: halamanDitempuh,
    hari_berjalan: hariBerjalan,
    kartu_target_hari_ini: halamanTarget,
    kartu_ditempuh_hari_ini: halamanDitempuhHariIni,
    total_kartu_keseluruhan: totalKartuKeseluruhan(),
    status,
    selisih_kartu: selisihHalaman,
    selisih_tampilan: `${status === 'SUDAH_CAPAI_PACE' ? 'lebih' : 'kurang'} ${tampilan.nilai} ${tampilan.satuan}`,
    persen_pace: persenPace,
    sudah_baca_hari_ini: sudahBacaHariIni,
  };
}

// ========== LOG BACAAN HARIAN (lelang + rekap mingguan) ==========

// Upsert: kalau user udah kirim log hari itu, update bacaan_id_akhir/jumlah_kartu-nya.
// Dipanggil tiap kali kirimBacaanLanjutanUntukAgent sukses ngirim (index.js).
// jumlahKartu: default 1 (satu kartu terkirim). Lapor by-ayat mengisi selisih posisi
// supaya lompatan beberapa halaman tidak cuma dihitung 1.
function catatLogBacaanHarian(userJid, tanggalLog, bacaanId, suratAyat, statusPace, jumlahKartu = 1) {
  // 0 diperbolehkan: laporan yang tidak memajukan posisi (ulang ayat sama) hanya memperbarui
  // label tanpa menambah kredit target harian.
  const tambah = Number.isInteger(jumlahKartu) && jumlahKartu >= 0 ? jumlahKartu : 1;
  const existing = db
    .prepare('SELECT * FROM log_bacaan_harian WHERE user_jid = ? AND tanggal = ?')
    .get(userJid, tanggalLog);

  if (!existing) {
    db.prepare(`
      INSERT INTO log_bacaan_harian
        (user_jid, tanggal, bacaan_id_awal, bacaan_id_akhir, surat_ayat_akhir, jumlah_kartu, status_pace_akhir)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userJid, tanggalLog, bacaanId, bacaanId, suratAyat, tambah, statusPace || null);
  } else {
    db.prepare(`
      UPDATE log_bacaan_harian
      SET bacaan_id_akhir = ?, surat_ayat_akhir = ?, jumlah_kartu = jumlah_kartu + ?, status_pace_akhir = ?
      WHERE user_jid = ? AND tanggal = ?
    `).run(bacaanId, suratAyat, tambah, statusPace || null, userJid, tanggalLog);
  }
}

// KOREKSI (bukan tambah): timpa posisi/label catatan di tanggal tertentu tanpa mengubah
// jumlah_kartu yang ada. Kalau barisnya belum ada, dibuat dengan jumlah_kartu 1.
function setLogBacaanHarian(userJid, tanggalLog, bacaanId, suratAyat) {
  const existing = db
    .prepare('SELECT id FROM log_bacaan_harian WHERE user_jid = ? AND tanggal = ?')
    .get(userJid, tanggalLog);
  if (!existing) {
    db.prepare(`
      INSERT INTO log_bacaan_harian (user_jid, tanggal, bacaan_id_awal, bacaan_id_akhir, surat_ayat_akhir, jumlah_kartu)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(userJid, tanggalLog, bacaanId, bacaanId, suratAyat);
  } else {
    db.prepare(`
      UPDATE log_bacaan_harian SET bacaan_id_akhir = ?, surat_ayat_akhir = ? WHERE user_jid = ? AND tanggal = ?
    `).run(bacaanId, suratAyat, userJid, tanggalLog);
  }
}

// Laporan manual (mode reminder-saja, tanpa kartu). Nambahin ke jumlah_kartu hari itu
// sebagai representasi "halaman dibaca", reuse kolom yang sama dengan mode kartu
// supaya hitungSisaProgressUser tetap konsisten tanpa perlu kolom baru.
function catatLaporanBacaanManual(userJid, tanggalISO, jumlahHalaman) {
  const existing = db
    .prepare('SELECT * FROM log_bacaan_harian WHERE user_jid = ? AND tanggal = ?')
    .get(userJid, tanggalISO);

  if (!existing) {
    db.prepare(`
      INSERT INTO log_bacaan_harian (user_jid, tanggal, jumlah_kartu)
      VALUES (?, ?, ?)
    `).run(userJid, tanggalISO, jumlahHalaman);
  } else {
    db.prepare(`
      UPDATE log_bacaan_harian SET jumlah_kartu = jumlah_kartu + ?
      WHERE user_jid = ? AND tanggal = ?
    `).run(jumlahHalaman, userJid, tanggalISO);
  }
}

// Dipakai buat jawab "kemarin baca apa" -- knowledge gak cuma hari ini.
function getLogBacaanHarianByTanggal(userJid, tanggalISO) {
  return db
    .prepare('SELECT * FROM log_bacaan_harian WHERE user_jid = ? AND tanggal = ?')
    .get(userJid, tanggalISO);
}

// Range tanggal (inklusif), dipakai buat rekap mingguan (poin 2).
function getLogBacaanHarianRange(userJid, tanggalMulaiISO, tanggalSelesaiISO) {
  return db
    .prepare(`
      SELECT * FROM log_bacaan_harian
      WHERE user_jid = ? AND tanggal >= ? AND tanggal <= ?
      ORDER BY tanggal ASC
    `)
    .all(userJid, tanggalMulaiISO, tanggalSelesaiISO);
}

// Rata-rata capaian target harian di rentang tanggal (inklusif): jumlah_kartu per hari vs target
// harian user, tiap hari di-cap 100%, hari tanpa log = 0%. Hari sebelum user mulai baca tidak
// dihitung. null kalau user tak punya target valid.
function hitungPersenMingguan(jid, tanggalMulaiISO, tanggalSelesaiISO) {
  const user = getUser(jid);
  const target = hitungTargetHarian(user.target_juz_per_hari);
  if (!target || target <= 0) return null;
  let awal = tanggalMulaiISO;
  if (user.tanggal_mulai_baca && user.tanggal_mulai_baca > awal) awal = user.tanggal_mulai_baca;
  const jumlahHari = selisihHariISO(awal, tanggalSelesaiISO) + 1;
  if (jumlahHari <= 0) return null;
  const logs = getLogBacaanHarianRange(jid, awal, tanggalSelesaiISO);
  let total = 0;
  for (const l of logs) total += Math.min(1, (l.jumlah_kartu || 0) / target);
  return Math.round((total / jumlahHari) * 100);
}

// Anggota grup yang DI_BAWAH_PACE hari ini -- basis tawaran "lelang" pas Isya (poin 1).
// Reuse hitungSisaProgressUser per anggota (sama kayak getRekapProgressGroup), tapi
// difilter khusus status DI_BAWAH_PACE dan sudah_aktivasi_personal=true saja.
function getAnggotaDiBawahPaceHariIni(groupJid) {
  const anggotaJids = getAnggotaGroup(groupJid);
  const hasil = [];
  for (const jid of anggotaJids) {
    const user = getUser(jid);
    if (user.is_registered !== 1 || user.is_active !== 1) continue;
    const sisa = hitungSisaProgressUser(jid);
    if (sisa.ada_target && sisa.status === 'DI_BAWAH_PACE') {
      hasil.push({ jid, nama: user.name || 'Sahabat', selisih_tampilan: sisa.selisih_tampilan });
    }
  }
  return hasil;
}

// ========== JUMAT AL-KAHFI (poin 3) ==========
// Posisi terpisah dari progress khataman utama -- cuma dalam surat Al-Kahfi,
// dicicil tiap Jumat. Dimulai dari bacaan_id manapun yang path-nya surat_ayat LIKE 'Al-Kahfi%'.

function updateLastSentAlkahfiId(jid, newId) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET last_sent_alkahfi_id = ? WHERE jid = ?').run(newId, jid);
}

function setTanggalTerakhirAlkahfi(jid, tanggalISO) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET tanggal_terakhir_alkahfi = ? WHERE jid = ?').run(tanggalISO, jid);
}

// ========== GROUPS (murni sosial, phase 3) ==========

function getOrCreateGroup(jid, nama = null) {
  let group = db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid);
  if (!group) {
    db.prepare('INSERT INTO groups (jid, nama) VALUES (?, ?)').run(jid, nama);
    group = db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid);
  }
  return group;
}

function getGroup(jid) {
  return db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid);
}

function isGroupAktif(jid) {
  const g = getGroup(jid);
  return !!g && g.is_aktif === 1;
}

function aktifkanGroup(jid, nama = null) {
  getOrCreateGroup(jid, nama);
  db.prepare('UPDATE groups SET is_aktif = 1 WHERE jid = ?').run(jid);
}

function setGroupState(jid, state) {
  getOrCreateGroup(jid);
  db.prepare('UPDATE groups SET state = ? WHERE jid = ?').run(state, jid);
}

function setGroupWaktuMotivasiTerakhir(jid, tanggalISO) {
  getOrCreateGroup(jid);
  db.prepare('UPDATE groups SET waktu_motivasi_terakhir = ? WHERE jid = ?').run(tanggalISO, jid);
}

function getAllGroupsAktif() {
  return db.prepare('SELECT * FROM groups WHERE is_aktif = 1').all();
}

function tambahAnggotaGroup(groupJid, userJid) {
  getOrCreateGroup(groupJid);
  db.prepare(
    'INSERT OR IGNORE INTO group_members (group_jid, user_jid) VALUES (?, ?)'
  ).run(groupJid, userJid);
}

function hapusAnggotaGroup(groupJid, userJid) {
  db.prepare('DELETE FROM group_members WHERE group_jid = ? AND user_jid = ?').run(groupJid, userJid);
}

function getAnggotaGroup(groupJid) {
  return db.prepare('SELECT user_jid FROM group_members WHERE group_jid = ?').all(groupJid).map((r) => r.user_jid);
}

// Cari grup sosial (yang aktif) di mana user ini terdaftar sebagai anggota,
// dipakai untuk auto-link group_sosial_jid saat user baru onboarding personal
// walau dia belum pernah chat duluan di grup tersebut.
function cariGroupUntukUserDariRoster(jid) {
  const row = db
    .prepare(
      `SELECT gm.group_jid FROM group_members gm
       JOIN groups g ON g.jid = gm.group_jid
       WHERE gm.user_jid = ? AND g.is_aktif = 1
       ORDER BY gm.joined_at ASC LIMIT 1`
    )
    .get(jid);
  return row ? row.group_jid : null;
}

function catatAktivitasGroup(groupJid, userJid, jenis, catatan = null) {
  db.prepare(
    'INSERT INTO group_activity_log (group_jid, user_jid, jenis, catatan) VALUES (?, ?, ?, ?)'
  ).run(groupJid, userJid, jenis, catatan);
}

// Rekap ringan: anggota grup + progress masing-masing (dari tabel users), buat ditampilkan
// saat ada yang nanya "progress grup gimana" atau buat broadcast motivasi mingguan.
// PENTING: bedakan eksplisit antara "belum aktivasi personal" vs "sudah aktivasi tapi
// belum mulai baca" -- dua kondisi ini beda dan jangan ketukar, supaya AI tidak salah
// bilang "belum mulai" untuk orang yang sebenarnya belum pernah kirim "dawam".
function getRekapProgressGroup(groupJid) {
  const anggotaJids = getAnggotaGroup(groupJid);
  return anggotaJids.map((jid) => {
    const user = getUser(jid);

    if (user.is_registered !== 1) {
      return {
        nama: user.name || null,
        jid,
        sudah_aktivasi_personal: false,
      };
    }

    const bacaan = getBacaanByUrutan(user.last_sent_bacaan_id);
    const sisaProgress = hitungSisaProgressUser(jid);

    return {
      nama: user.name || 'Sahabat',
      jid,
      sudah_aktivasi_personal: true,
      posisi_terakhir: bacaan?.surat_ayat || 'belum mulai baca',
      juz_sekarang: bacaan?.juz ?? null,
      kartu_ditempuh: sisaProgress.kartu_ditempuh ?? 0,
      target_hari_per_juz: user.target_juz_per_hari || 'belum ditentukan',
      status_pace: sisaProgress.status || null,
      selisih_dari_target: sisaProgress.selisih_tampilan || null,
      persen_pace: sisaProgress.persen_pace ?? null,
      kartu_ditempuh_hari_ini: sisaProgress.kartu_ditempuh_hari_ini ?? null,
      kartu_target_hari_ini: sisaProgress.kartu_target_hari_ini ?? null,
      sudah_baca_hari_ini: sisaProgress.sudah_baca_hari_ini ?? false,
    };
  });
}

// ========== CHAT HISTORY (untuk agent) ==========

const BATAS_SIMPAN_HISTORI_PER_CHAT = 200; // pruning, biar tabel tidak membengkak

function simpanChatHistory(chatJid, role, content, senderJid = null) {
  if (!content || !content.trim()) return;
  db.prepare(
    'INSERT INTO chat_history (chat_jid, sender_jid, role, content) VALUES (?, ?, ?, ?)'
  ).run(chatJid, senderJid, role, content);

  // Pruning: buang yang lama kalau sudah lewat batas
  db.prepare(`
    DELETE FROM chat_history
    WHERE chat_jid = ? AND id NOT IN (
      SELECT id FROM chat_history WHERE chat_jid = ? ORDER BY id DESC LIMIT ?
    )
  `).run(chatJid, chatJid, BATAS_SIMPAN_HISTORI_PER_CHAT);
}

// Return array {role, content} urut dari LAMA ke BARU, siap dimasukkan ke messages agent.
function getChatHistory(chatJid, limit = 12) {
  const rows = db
    .prepare('SELECT role, content FROM chat_history WHERE chat_jid = ? ORDER BY id DESC LIMIT ?')
    .all(chatJid, limit);
  return rows.reverse();
}

// ========== POWER USER & FEEDBACK ==========

const KATEGORI_FEEDBACK = ['BUG', 'SARAN', 'KELUHAN', 'LAIN'];

function tambahPowerUser(jid, olehJid) {
  const r = db
    .prepare('INSERT OR IGNORE INTO power_users (jid, ditambahkan_oleh) VALUES (?, ?)')
    .run(jid, olehJid || null);
  return r.changes > 0; // false = sudah power user sebelumnya
}

function hapusPowerUser(jid) {
  return db.prepare('DELETE FROM power_users WHERE jid = ?').run(jid).changes > 0;
}

function isPowerUserDb(jid) {
  return !!db.prepare('SELECT 1 FROM power_users WHERE jid = ?').get(jid);
}

function getAllPowerUsers() {
  return db
    .prepare(
      `SELECT p.jid, p.waktu, u.name FROM power_users p
       LEFT JOIN users u ON u.jid = p.jid ORDER BY p.waktu, p.jid`
    )
    .all();
}

function simpanFeedbackPower(userJid, isi, kategori) {
  const kat = KATEGORI_FEEDBACK.includes(kategori) ? kategori : 'LAIN';
  const r = db
    .prepare('INSERT INTO feedback_power (user_jid, isi_asli, kategori, tanggal) VALUES (?, ?, ?, ?)')
    .run(userJid, isi, kat, tanggalHariIniISO());
  return Number(r.lastInsertRowid);
}

function getFeedbackPower(id) {
  return db.prepare('SELECT * FROM feedback_power WHERE id = ?').get(id) || null;
}

function hitungFeedbackPowerHariIni(userJid) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM feedback_power WHERE user_jid = ? AND tanggal = ?')
    .get(userJid, tanggalHariIniISO()).n;
}

// Feedback PENDING milik user yang isinya sama persis (cegah dobel karena AI memanggil ulang).
function cariFeedbackPendingSama(userJid, isi) {
  return (
    db
      .prepare("SELECT id FROM feedback_power WHERE user_jid = ? AND status = 'PENDING' AND isi_asli = ?")
      .get(userJid, isi)?.id ?? null
  );
}

// Hanya feedback milik user itu sendiri yang MASIH PENDING (belum masuk digest) yang boleh diubah.
function ubahFeedbackPending(id, userJid, isiBaru, kategori) {
  const kat = KATEGORI_FEEDBACK.includes(kategori) ? kategori : null;
  return (
    db
      .prepare(
        `UPDATE feedback_power SET isi_asli = ?, kategori = COALESCE(?, kategori), isi_rapi = NULL
         WHERE id = ? AND user_jid = ? AND status = 'PENDING'`
      )
      .run(isiBaru, kat, id, userJid).changes > 0
  );
}

function getFeedbackPowerPending() {
  return db
    .prepare(
      `SELECT f.*, u.name AS nama FROM feedback_power f
       LEFT JOIN users u ON u.jid = f.user_jid
       WHERE f.status = 'PENDING' ORDER BY f.id`
    )
    .all();
}

function getFeedbackPowerUser(userJid, limit = 10) {
  return db
    .prepare('SELECT * FROM feedback_power WHERE user_jid = ? ORDER BY id DESC LIMIT ?')
    .all(userJid, limit)
    .reverse();
}

// Daftar untuk operator: yang belum selesai (PENDING + TERKIRIM), terlama dulu.
function getFeedbackPowerBelumSelesai() {
  return db
    .prepare(
      `SELECT f.*, u.name AS nama FROM feedback_power f
       LEFT JOIN users u ON u.jid = f.user_jid
       WHERE f.status != 'SELESAI' ORDER BY f.id`
    )
    .all();
}

function simpanIsiRapiFeedback(id, isiRapi) {
  db.prepare('UPDATE feedback_power SET isi_rapi = ? WHERE id = ?').run(isiRapi, id);
}

function tandaiFeedbackTerkirim(ids) {
  const stmt = db.prepare(
    "UPDATE feedback_power SET status = 'TERKIRIM', dikirim_pada = ? WHERE id = ? AND status = 'PENDING'"
  );
  const now = new Date().toISOString();
  db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
}

// Tandai selesai. Mengembalikan baris yang BARU berubah jadi SELESAI (yang sudah selesai / tidak ada
// dilewati), lengkap dengan nama user, supaya operator & notifikasi memakai data yang sama.
function selesaikanFeedbackPower(ids, catatan) {
  const now = new Date().toISOString();
  const ambil = db.prepare(
    `SELECT f.*, u.name AS nama FROM feedback_power f
     LEFT JOIN users u ON u.jid = f.user_jid WHERE f.id = ?`
  );
  const ubah = db.prepare(
    "UPDATE feedback_power SET status = 'SELESAI', selesai_pada = ?, catatan_selesai = ? WHERE id = ? AND status != 'SELESAI'"
  );
  const hasil = [];
  db.transaction(() => {
    for (const id of ids) {
      if (ubah.run(now, catatan || null, id).changes > 0) hasil.push(ambil.get(id));
    }
  })();
  return hasil;
}

function tandaiUserDiberitahuSelesai(ids) {
  const stmt = db.prepare('UPDATE feedback_power SET user_diberitahu_pada = ? WHERE id = ?');
  const now = new Date().toISOString();
  db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
}

function sudahKirimDigestHariIni() {
  return !!db.prepare('SELECT 1 FROM feedback_digest_log WHERE tanggal = ?').get(tanggalHariIniISO());
}

function catatDigestTerkirim(jumlah) {
  db.prepare('INSERT OR REPLACE INTO feedback_digest_log (tanggal, jumlah) VALUES (?, ?)').run(
    tanggalHariIniISO(),
    jumlah
  );
}

module.exports = {
  // power user & feedback
  KATEGORI_FEEDBACK,
  tambahPowerUser,
  hapusPowerUser,
  isPowerUserDb,
  getAllPowerUsers,
  simpanFeedbackPower,
  getFeedbackPower,
  hitungFeedbackPowerHariIni,
  cariFeedbackPendingSama,
  ubahFeedbackPending,
  getFeedbackPowerPending,
  getFeedbackPowerUser,
  getFeedbackPowerBelumSelesai,
  simpanIsiRapiFeedback,
  tandaiFeedbackTerkirim,
  selesaikanFeedbackPower,
  tandaiUserDiberitahuSelesai,
  sudahKirimDigestHariIni,
  catatDigestTerkirim,

  // tanggal WIB
  tanggalISO,
  tanggalHariIniISO,
  tanggalMundurISO,
  selisihHariISO,
  pastikanTanggalMulaiBaca,

  db,

  // bacaan
  insertBacaan,
  countBacaan,
  getBacaanByUrutan,
  cariBacaanBySuratLike,
  cariBacaanBySuratDanAyat,
  getUrutanMin,
  getUrutanMax,
  pathArabDariKode,
  pathIndoDariKode,
  getBacaanByKode,
  hitungJumlahKartuDalamJuz,

  // users - existing
  getOrCreateUser,
  getUser,
  isUserRegistered,
  registerUser,
  setUserName,
  setUserLocation,
  getUserName,
  setUserState,
  getUserState,
  getAllUsers,

  // users - phase 2
  setUserGender,
  setUserTarget,
  setUserMotivasi,
  setUserMulaiSurat,
  updateLastSentBacaanId,
  setTanggalMulaiBaca,
  setStartBacaanId,
  setTanggalTerakhirBaca,
  incrementNoResponse,
  resetNoResponse,
  setModeArabSaja,
  setWaktuTawaranTerakhir,
  setGroupSosialUser,
  setSudahLaporSesiIni,
  setGroupSosialJikaBelumAda,
  // stop/resume subscription
  isUserActive,
  nonaktifkanUser,
  aktifkanKembaliUser,
  simpanFeedbackBerhenti,

  // onboarding conversational
  FIELD_ONBOARDING_WAJIB,
  OPSI_TARGET_VALID,
  isTargetValid,
  getFieldOnboardingKosong,
  isOnboardingLengkap,
  updateUserFields,
  hitungHariBerjalanUser,
  hitungSisaProgressUser,
  hitungHalamanDitempuhDenganWrap,
  sudahKhatamSetelahWrap,
  sudahKhatamSetelahKirim,
  hitungTargetHarian,
  rataKartuPerJuz,
  hitungPersenMingguan,
  setLogBacaanHarian,
  JUMLAH_HALAMAN_MUSHAF,
  kartuPerHalaman,
  kartuKeHalaman,
  halamanKeKartu,
  bulatkanHalaman,

  // groups - phase 3 (sosial)
  getOrCreateGroup,
  getGroup,
  isGroupAktif,
  aktifkanGroup,
  setGroupState,
  setGroupWaktuMotivasiTerakhir,
  getAllGroupsAktif,
  tambahAnggotaGroup,
  hapusAnggotaGroup,
  getAnggotaGroup,
  catatAktivitasGroup,
  getRekapProgressGroup,
  cariGroupUntukUserDariRoster,

    // chat history (untuk agent)
  simpanChatHistory,
  getChatHistory,

  // log bacaan harian (lelang + rekap mingguan)
  catatLogBacaanHarian,
  getLogBacaanHarianByTanggal,
  getLogBacaanHarianRange,
  getAnggotaDiBawahPaceHariIni,
  catatLaporanBacaanManual,

  // Jumat Al-Kahfi
  updateLastSentAlkahfiId,
  setTanggalTerakhirAlkahfi,
};