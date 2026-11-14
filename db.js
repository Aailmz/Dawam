const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'dawam.db'));

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

// ========== BACAAN ==========

function insertBacaan(row) {
  const stmt = db.prepare(`
    INSERT INTO bacaan (kode, urutan, halaman, bagian, juz, surat_ayat, ayat_terpotong)
    VALUES (@kode, @urutan, @halaman, @bagian, @juz, @surat_ayat, @ayat_terpotong)
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
function pathArabDariKode(kode) {
  return `images/kartu-${kode}.jpg`;
}
function pathIndoDariKode(kode) {
  return `images/terjemahan-${kode}.jpg`;
}

function cariBacaanBySuratLike(suratKeyword) {
  return db
    .prepare('SELECT * FROM bacaan WHERE surat_ayat LIKE ? ORDER BY urutan ASC LIMIT 1')
    .get(`%${suratKeyword}%`);
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
  const entries = Object.entries(data || {}).filter(([k, v]) => {
    if (!kolomValid.includes(k) || v === null || v === undefined || v === '') return false;
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
  const mulai = new Date(user.tanggal_mulai_baca);
  const sekarang = new Date();
  const mulaiTengahMalam = new Date(mulai.getFullYear(), mulai.getMonth(), mulai.getDate());
  const sekarangTengahMalam = new Date(sekarang.getFullYear(), sekarang.getMonth(), sekarang.getDate());
  return Math.floor((sekarangTengahMalam - mulaiTengahMalam) / (1000 * 60 * 60 * 24)) + 1;
}

function totalKartuKeseluruhan() {
  return countBacaan(); // sekitar 1.808, dihitung dari data riil, bukan hardcode
}
// Rata-rata kartu/juz dipakai HANYA sebagai estimasi target harian (lihat catatan
// di hitungSisaProgressUser) -- jumlah kartu per juz di skema baru TIDAK seragam.
function rataKartuPerJuz() {
  return totalKartuKeseluruhan() / 30;
}

// Ubah selisih halaman jadi deskripsi yang enak dibaca: halaman kalau kecil (<1 juz),
// juz (bulat, tanpa desimal) kalau besar. Dipakai di sisi "display", basis hitung tetap halaman.
function formatSelisihUntukTampilan(selisihHalamanAbs) {
  if (selisihHalamanAbs < rataKartuPerJuz()) {
    return { satuan: 'halaman', nilai: Math.round(selisihHalamanAbs) };
  }
  const juz = Math.round(selisihHalamanAbs / rataKartuPerJuz());
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

// Basis perhitungan: JARAK YANG SUDAH DITEMPUH dari titik mulai (start_bacaan_id),
// BUKAN posisi absolut di buku. User bisa mulai dari surat manapun (tidak selalu
// Al-Fatihah) -- posisi tinggi tidak berarti progress besar kalau start-nya juga tinggi.
function hitungSisaProgressUser(jid) {
  const user = getUser(jid);
  const bacaan = getBacaanById(user.last_sent_bacaan_id);
  const juzSekarang = bacaan?.juz ?? null;
  const posisiSekarang = user.last_sent_bacaan_id || 0;
  const startBacaanId = user.start_bacaan_id || 0;
  const halamanDitempuh = hitungHalamanDitempuhDenganWrap(startBacaanId, posisiSekarang);

  const hariIniISOAwal = new Date().toISOString().slice(0, 10);
  if (!user.target_juz_per_hari || !user.tanggal_mulai_baca) {
    return {
      ada_target: false,
      target_juz_per_hari: user.target_juz_per_hari || null,
      juz_sekarang: juzSekarang,
      halaman_posisi_sekarang: posisiSekarang,
      halaman_ditempuh: halamanDitempuh,
      total_halaman_keseluruhan: totalKartuKeseluruhan(),
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
      halaman_posisi_sekarang: posisiSekarang,
      halaman_ditempuh: halamanDitempuh,
      total_halaman_keseluruhan: totalKartuKeseluruhan(),
    };
  }

  // Target HARIAN murni -- tidak dikali hariBerjalan, tidak bawa-bawa defisit hari
  // sebelumnya. Dibandingkan dengan halaman yang ditempuh HARI INI SAJA, bukan
  // halamanDitempuh total sejak mulai.
  const halamanTarget = Math.round(halamanPerHari);
  const hariIniISOUntukLog = new Date().toISOString().slice(0, 10);
  const logHariIni = getLogBacaanHarianByTanggal(jid, hariIniISOUntukLog);
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
    halaman_ditempuh_hari_ini: halamanDitempuhHariIni, // <-- tambahan
    total_halaman_keseluruhan: totalKartuKeseluruhan(),
    status,
    selisih_halaman: selisihHalaman,
    selisih_tampilan: `${status === 'SUDAH_CAPAI_PACE' ? 'lebih' : 'kurang'} ${tampilan.nilai} ${tampilan.satuan}`,
    persen_pace: persenPace,
    sudah_baca_hari_ini: sudahBacaHariIni,
  };
}

// ========== LOG BACAAN HARIAN (lelang + rekap mingguan) ==========

// Upsert: kalau user udah kirim log hari itu, update bacaan_id_akhir/jumlah_kartu-nya.
// Dipanggil tiap kali kirimBacaanLanjutanUntukAgent sukses ngirim (index.js).
function catatLogBacaanHarian(userJid, tanggalISO, bacaanId, suratAyat, statusPace) {
  const existing = db
    .prepare('SELECT * FROM log_bacaan_harian WHERE user_jid = ? AND tanggal = ?')
    .get(userJid, tanggalISO);

  if (!existing) {
    db.prepare(`
      INSERT INTO log_bacaan_harian
        (user_jid, tanggal, bacaan_id_awal, bacaan_id_akhir, surat_ayat_akhir, jumlah_kartu, status_pace_akhir)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(userJid, tanggalISO, bacaanId, bacaanId, suratAyat, statusPace || null);
  } else {
    db.prepare(`
      UPDATE log_bacaan_harian
      SET bacaan_id_akhir = ?, surat_ayat_akhir = ?, jumlah_kartu = jumlah_kartu + 1, status_pace_akhir = ?
      WHERE user_jid = ? AND tanggal = ?
    `).run(bacaanId, suratAyat, statusPace || null, userJid, tanggalISO);
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

function getBacaanAlkahfiById(id) {
  const row = db.prepare('SELECT * FROM bacaan WHERE id = ? AND surat_ayat LIKE ?').get(id, 'Al-Kahfi%');
  return row || null;
}

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

    const bacaan = getBacaanById(user.last_sent_bacaan_id);
    const sisaProgress = hitungSisaProgressUser(jid);

    return {
      nama: user.name || 'Sahabat',
      jid,
      sudah_aktivasi_personal: true,
      posisi_terakhir: bacaan?.surat_ayat || 'belum mulai baca',
      juz_sekarang: bacaan?.juz ?? null,
      halaman_ditempuh: sisaProgress.halaman_ditempuh ?? 0,
      target_hari_per_juz: user.target_juz_per_hari || 'belum ditentukan',
      status_pace: sisaProgress.status || null,
      selisih_dari_target: sisaProgress.selisih_tampilan || null,
      persen_pace: sisaProgress.persen_pace ?? null,
      halaman_ditempuh_hari_ini: sisaProgress.halaman_ditempuh_hari_ini ?? null, // <-- tambahan
      halaman_target_hari_ini: sisaProgress.halaman_target_hari_ini ?? null,     // <-- tambahan
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
  cariBacaanBySuratDanAyat,

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
  getBacaanAlkahfiById,
  updateLastSentAlkahfiId,
  setTanggalTerakhirAlkahfi,
};