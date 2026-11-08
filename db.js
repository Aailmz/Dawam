const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'dawam.db'));

// ========== SKEMA ==========

db.exec(`
  CREATE TABLE IF NOT EXISTS bacaan (
    id INTEGER PRIMARY KEY,
    hari_global INTEGER NOT NULL,
    hari_dalam_juz INTEGER NOT NULL,
    juz INTEGER NOT NULL,
    waktu_sholat TEXT NOT NULL,
    surat_ayat TEXT NOT NULL,
    jumlah_kata INTEGER,
    path_arab TEXT NOT NULL,
    path_indo TEXT NOT NULL
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

// Migrasi: tabel 'ayat' (generic image, Phase 1) sudah digantikan tabel 'bacaan'.
const tabelLamaMasihAda = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ayat'`)
  .get();
if (tabelLamaMasihAda) {
  db.exec(`DROP TABLE ayat`);
  console.log('✅ Tabel "ayat" (lama, Phase 1) dihapus — digantikan tabel "bacaan".');
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

// ========== BACAAN ==========

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

// ========== ONBOARDING CONVERSATIONAL (phase 2) ==========

const FIELD_ONBOARDING_WAJIB = ['name', 'location', 'gender', 'target_juz_per_hari', 'motivasi_personal'];
// mulai_surat sengaja TIDAK wajib -- kalau kosong, default mulai dari awal.

function getFieldOnboardingKosong(jid) {
  const user = getUser(jid);
  return FIELD_ONBOARDING_WAJIB.filter((f) => !user[f]);
}

function isOnboardingLengkap(jid) {
  return getFieldOnboardingKosong(jid).length === 0;
}

function updateUserFields(jid, data) {
  getOrCreateUser(jid);
  const kolomValid = ['name', 'location', 'gender', 'target_juz_per_hari', 'motivasi_personal', 'mulai_surat'];
  const entries = Object.entries(data || {}).filter(
    ([k, v]) => kolomValid.includes(k) && v !== null && v !== undefined && v !== ''
  );
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

const TOTAL_HALAMAN_KESELURUHAN = 900; // sesuai batas nextId di index.js (900 halaman ~ 30 juz)
const HALAMAN_PER_JUZ = TOTAL_HALAMAN_KESELURUHAN / 30; // rata 30 halaman/juz

// Ubah selisih halaman jadi deskripsi yang enak dibaca: halaman kalau kecil (<1 juz),
// juz (bulat, tanpa desimal) kalau besar. Dipakai di sisi "display", basis hitung tetap halaman.
function formatSelisihUntukTampilan(selisihHalamanAbs) {
  if (selisihHalamanAbs < HALAMAN_PER_JUZ) {
    return { satuan: 'halaman', nilai: Math.round(selisihHalamanAbs) };
  }
  const juz = Math.round(selisihHalamanAbs / HALAMAN_PER_JUZ);
  return { satuan: 'juz', nilai: juz };
}

// Basis perhitungan: JARAK YANG SUDAH DITEMPUH dari titik mulai (start_bacaan_id),
// BUKAN posisi absolut di buku. User bisa mulai dari surat manapun (tidak selalu
// Al-Fatihah) -- posisi tinggi tidak berarti progress besar kalau start-nya juga tinggi.
function hitungSisaProgressUser(jid) {
  const user = getUser(jid);
  const bacaan = getBacaanById(user.last_sent_bacaan_id);
  const juzSekarang = bacaan?.juz ?? null;
  const posisiSekarang = user.last_sent_bacaan_id || 0;
  const startBacaanId = user.start_bacaan_id || 0;
  const halamanDitempuh = Math.max(0, posisiSekarang - startBacaanId);

  const hariIniISOAwal = new Date().toISOString().slice(0, 10);
  if (!user.target_juz_per_hari || user.target_juz_per_hari === '6' || !user.tanggal_mulai_baca) {
    return {
      ada_target: false,
      target_juz_per_hari: user.target_juz_per_hari || null,
      juz_sekarang: juzSekarang,
      halaman_posisi_sekarang: posisiSekarang,
      halaman_ditempuh: halamanDitempuh,
      total_halaman_keseluruhan: TOTAL_HALAMAN_KESELURUHAN,
      sudah_baca_hari_ini: user.tanggal_terakhir_baca === hariIniISOAwal,
    };
  }

  const hariBerjalan = hitungHariBerjalanUser(jid);

  let halamanPerHari;
  if (user.target_juz_per_hari === '3') halamanPerHari = HALAMAN_PER_JUZ / 3;
  else if (user.target_juz_per_hari === '1') halamanPerHari = HALAMAN_PER_JUZ / 1;
  else {
    return {
      ada_target: false,
      target_juz_per_hari: user.target_juz_per_hari,
      juz_sekarang: juzSekarang,
      halaman_posisi_sekarang: posisiSekarang,
      halaman_ditempuh: halamanDitempuh,
      total_halaman_keseluruhan: TOTAL_HALAMAN_KESELURUHAN,
    };
  }

  const halamanTarget = Math.round(halamanPerHari * hariBerjalan);
  const selisihHalaman = halamanTarget - halamanDitempuh;

  let status;
  if (selisihHalaman > 0) status = 'DI_BAWAH_PACE';
  else if (selisihHalaman < 0) status = 'SUDAH_CAPAI_PACE';
  else status = 'PAS_PACE';

  const tampilan = formatSelisihUntukTampilan(Math.abs(selisihHalaman));
  const persenPace = halamanTarget > 0 ? Math.round((halamanDitempuh / halamanTarget) * 100) : null;
  const hariIniISO = new Date().toISOString().slice(0, 10);
  const sudahBacaHariIni = user.tanggal_terakhir_baca === hariIniISO;

  return {
    ada_target: true,
    target_juz_per_hari: user.target_juz_per_hari,
    juz_sekarang: juzSekarang,
    halaman_posisi_sekarang: posisiSekarang,
    halaman_ditempuh: halamanDitempuh,
    hari_berjalan: hariBerjalan,
    halaman_target_hari_ini: halamanTarget,
    total_halaman_keseluruhan: TOTAL_HALAMAN_KESELURUHAN,
    status,
    selisih_halaman: selisihHalaman,
    selisih_tampilan: `${status === 'SUDAH_CAPAI_PACE' ? 'lebih' : 'kurang'} ${tampilan.nilai} ${tampilan.satuan}`,
    persen_pace: persenPace,
    sudah_baca_hari_ini: sudahBacaHariIni,
  };
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

    const bacaan = getBacaanById(user.last_sent_bacaan_id);
    const sisaProgress = hitungSisaProgressUser(jid);

    return {
      nama: user.name || 'Sahabat',
      jid, // dibutuhkan untuk mentions saat tag di grup
      sudah_aktivasi_personal: true,
      posisi_terakhir: bacaan?.surat_ayat || 'belum mulai baca',
      juz_sekarang: bacaan?.juz ?? null,
      halaman_ditempuh: sisaProgress.halaman_ditempuh ?? 0,
      target_hari_per_juz: user.target_juz_per_hari || 'belum ditentukan',
      status_pace: sisaProgress.status || null,
      selisih_dari_target: sisaProgress.selisih_tampilan || null,
      persen_pace: sisaProgress.persen_pace ?? null,
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
  setStartBacaanId,
  setTanggalTerakhirBaca,
  incrementNoResponse,
  resetNoResponse,
  setModeArabSaja,
  setWaktuTawaranTerakhir,
  setGroupSosialUser,
  setSudahLaporSesiIni,
  setGroupSosialJikaBelumAda,

  // onboarding conversational
  FIELD_ONBOARDING_WAJIB,
  getFieldOnboardingKosong,
  isOnboardingLengkap,
  updateUserFields,
  hitungHariBerjalanUser,
  hitungSisaProgressUser,

  // groups - phase 3 (sosial)
  getOrCreateGroup,
  getGroup,
  isGroupAktif,
  aktifkanGroup,
  setGroupState,
  setGroupWaktuMotivasiTerakhir,
  getAllGroupsAktif,
  tambahAnggotaGroup,
  getAnggotaGroup,
  catatAktivitasGroup,
  getRekapProgressGroup,
  cariGroupUntukUserDariRoster,

  // chat history (untuk agent)
  simpanChatHistory,
  getChatHistory,
};