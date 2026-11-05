const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'dawam.db'));

// ========== SKEMA ==========

// Tabel 'bacaan' GANTI tabel 'ayat' lama (§1.3)
db.exec(`
  CREATE TABLE IF NOT EXISTS bacaan (
    id INTEGER PRIMARY KEY,              -- 1 sampai 900, selaras dengan kode B/T
    hari_global INTEGER NOT NULL,        -- 1 sampai 180
    hari_dalam_juz INTEGER NOT NULL,     -- 1 sampai 6
    juz INTEGER NOT NULL,                -- 1 sampai 30
    waktu_sholat TEXT NOT NULL,          -- 'subuh' | 'dzuhur' | 'ashar' | 'maghrib' | 'isya'
    surat_ayat TEXT NOT NULL,            -- contoh: "Al-Baqarah 142-143"
    jumlah_kata INTEGER,                 -- dari kolom "Kata" di PDF
    path_arab TEXT NOT NULL,             -- contoh: "images/arab_0031.jpg"
    path_indo TEXT NOT NULL              -- contoh: "images/indo_0031.jpg"
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

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    jid TEXT PRIMARY KEY,
    nama TEXT,
    is_aktif INTEGER DEFAULT 0,
    mode TEXT DEFAULT 'SHARED',
    target_juz_per_hari TEXT,
    last_sent_bacaan_id INTEGER DEFAULT 0,
    tanggal_mulai_baca TEXT,
    state TEXT DEFAULT 'IDLE',
    waktu_tawaran_terakhir TEXT
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

// Migrasi: tabel 'ayat' (generic image, Phase 1) sudah digantikan tabel 'bacaan'.
// Drop kalau masih ada peninggalan dari versi lama -- aman dijalankan walau tabelnya
// sudah tidak ada (IF EXISTS) atau walau db masih fresh (tidak melakukan apa-apa).
const tabelLamaMasihAda = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ayat'`)
  .get();
if (tabelLamaMasihAda) {
  db.exec(`DROP TABLE ayat`);
  console.log('✅ Tabel "ayat" (lama, Phase 1) dihapus — digantikan tabel "bacaan".');
}

// Migrasi kolom baru di 'users' (§2). SQLite tidak punya "ADD COLUMN IF NOT EXISTS",
// jadi kita cek dulu kolom yang sudah ada sebelum ALTER, supaya aman dijalankan berkali-kali.
function tambahKolomJikaBelumAda(namaKolom, definisiKolom) {
  const kolomSaatIni = db.prepare(`PRAGMA table_info(users)`).all().map((k) => k.name);
  if (!kolomSaatIni.includes(namaKolom)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${namaKolom} ${definisiKolom}`);
    console.log(`✅ Kolom users.${namaKolom} ditambahkan.`);
  }
}

tambahKolomJikaBelumAda('gender', 'TEXT');
tambahKolomJikaBelumAda('target_juz_per_hari', 'TEXT');
tambahKolomJikaBelumAda('motivasi_personal', 'TEXT');
tambahKolomJikaBelumAda('mulai_surat', 'TEXT');
tambahKolomJikaBelumAda('last_sent_bacaan_id', 'INTEGER DEFAULT 0');
tambahKolomJikaBelumAda('tanggal_mulai_baca', 'TEXT');
tambahKolomJikaBelumAda('consecutive_no_response', 'INTEGER DEFAULT 0');
tambahKolomJikaBelumAda('mode_baca_arab_saja', 'INTEGER DEFAULT 1');
tambahKolomJikaBelumAda('waktu_tawaran_terakhir', 'TEXT');

// ========== BACAAN (gantikan fungsi-fungsi AYAT lama) ==========

function insertBacaan(row) {
  const stmt = db.prepare(`
    INSERT INTO bacaan
      (id, hari_global, hari_dalam_juz, juz, waktu_sholat, surat_ayat, jumlah_kata, path_arab, path_indo)
    VALUES
      (@id, @hari_global, @hari_dalam_juz, @juz, @waktu_sholat, @surat_ayat, @jumlah_kata, @path_arab, @path_indo)
  `);
  return stmt.run(row);
}

function countBacaan() {
  const row = db.prepare('SELECT COUNT(*) as total FROM bacaan').get();
  return row.total;
}

function getBacaanById(id) {
  return db.prepare('SELECT * FROM bacaan WHERE id = ?').get(id);
}

// Cari bacaan berdasarkan surat_ayat (dipakai §3.1 saat parsing "mulai dari surat tertentu")
function cariBacaanBySuratLike(suratKeyword) {
  return db
    .prepare('SELECT * FROM bacaan WHERE surat_ayat LIKE ? ORDER BY id ASC LIMIT 1')
    .get(`%${suratKeyword}%`);
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

// ---- Kolom-kolom baru Phase 2 ----

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
  // aktif: true -> mode normal (arab+terjemah), false -> mode terjemah-saja
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET mode_baca_arab_saja = ? WHERE jid = ?').run(aktif ? 1 : 0, jid);
}

function setWaktuTawaranTerakhir(jid, tanggalISO) {
  getOrCreateUser(jid);
  db.prepare('UPDATE users SET waktu_tawaran_terakhir = ? WHERE jid = ?').run(tanggalISO, jid);
}

// Field yang wajib ada sebelum onboarding dianggap selesai
const FIELD_ONBOARDING_WAJIB = ['name', 'location', 'gender', 'target_juz_per_hari', 'motivasi_personal'];
// mulai_surat sengaja TIDAK wajib -- kalau kosong, default mulai dari awal (behavior lama tetap jalan)

function getFieldOnboardingKosong(jid) {
  const user = getUser(jid);
  return FIELD_ONBOARDING_WAJIB.filter((f) => !user[f]);
}

function isOnboardingLengkap(jid) {
  return getFieldOnboardingKosong(jid).length === 0;
}

// Update generik multi-field sekaligus, dipakai onboarding conversational.
// Hanya field yang ada di `data` yang di-update (partial).
function updateUserFields(jid, data) {
  getOrCreateUser(jid);
  const kolomValid = ['name', 'location', 'gender', 'target_juz_per_hari', 'motivasi_personal', 'mulai_surat'];
  const entries = Object.entries(data).filter(([k, v]) => kolomValid.includes(k) && v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return;

  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE users SET ${setClause} WHERE jid = ?`).run(...values, jid);
}

// Hitung hari berjalan sejak mulai baca (dipakai tool get_progress_user)
function hitungHariBerjalanUser(jid) {
  const user = getUser(jid);
  if (!user.tanggal_mulai_baca) return null;
  const mulai = new Date(user.tanggal_mulai_baca);
  const sekarang = new Date();
  const mulaiTengahMalam = new Date(mulai.getFullYear(), mulai.getMonth(), mulai.getDate());
  const sekarangTengahMalam = new Date(sekarang.getFullYear(), sekarang.getMonth(), sekarang.getDate());
  return Math.floor((sekarangTengahMalam - mulaiTengahMalam) / (1000 * 60 * 60 * 24)) + 1;
}

// ========== GROUPS ==========

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

function aktifkanGroup(jid, mode, targetJuzPerHari) {
  getOrCreateGroup(jid);
  db.prepare(
    'UPDATE groups SET is_aktif = 1, mode = ?, target_juz_per_hari = ? WHERE jid = ?'
  ).run(mode, targetJuzPerHari, jid);
}

function setGroupState(jid, state) {
  getOrCreateGroup(jid);
  db.prepare('UPDATE groups SET state = ? WHERE jid = ?').run(state, jid);
}

function updateGroupLastSentBacaanId(jid, newId) {
  db.prepare('UPDATE groups SET last_sent_bacaan_id = ? WHERE jid = ?').run(newId, jid);
}

function setGroupTanggalMulaiBaca(jid, tanggalISO) {
  db.prepare('UPDATE groups SET tanggal_mulai_baca = ? WHERE jid = ?').run(tanggalISO, jid);
}

function setGroupWaktuTawaranTerakhir(jid, tanggalISO) {
  db.prepare('UPDATE groups SET waktu_tawaran_terakhir = ? WHERE jid = ?').run(tanggalISO, jid);
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

function getAnggotaGroup(groupJid) {
  return db.prepare('SELECT user_jid FROM group_members WHERE group_jid = ?').all(groupJid).map((r) => r.user_jid);
}

module.exports = {
  db,

  // bacaan
  insertBacaan,
  countBacaan,
  getBacaanById,
  cariBacaanBySuratLike,

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
  incrementNoResponse,
  resetNoResponse,
  setModeArabSaja,
  setWaktuTawaranTerakhir,
  hitungHariBerjalanUser,
  getFieldOnboardingKosong,
  isOnboardingLengkap,
  updateUserFields,

  // groups
  getOrCreateGroup,
  getGroup,
  isGroupAktif,
  aktifkanGroup,
  setGroupState,
  updateGroupLastSentBacaanId,
  setGroupTanggalMulaiBaca,
  setGroupWaktuTawaranTerakhir,
  getAllGroupsAktif,
  tambahAnggotaGroup,
  getAnggotaGroup,
};