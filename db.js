const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'dawam.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS ayat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    juz INTEGER,
    halaman INTEGER,
    image_path TEXT NOT NULL
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

// ========== AYAT ==========

function insertAyat(juz, halaman, imagePath) {
  const stmt = db.prepare('INSERT INTO ayat (juz, halaman, image_path) VALUES (?, ?, ?)');
  return stmt.run(juz, halaman, imagePath);
}

function countAyat() {
  const row = db.prepare('SELECT COUNT(*) as total FROM ayat').get();
  return row.total;
}

// Ambil ayat berikutnya buat user tertentu (sequential berdasarkan progress dia)
function getNextAyatForUser(jid) {
  const user = getOrCreateUser(jid);
  let row = db
    .prepare('SELECT * FROM ayat WHERE id > ? ORDER BY id ASC LIMIT 1')
    .get(user.last_sent_id);

  // Kalau udah habis (sampai akhir), balik lagi ke id 1 (looping dari awal)
  if (!row) {
    row = db.prepare('SELECT * FROM ayat ORDER BY id ASC LIMIT 1').get();
  }
  return row;
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

function updateLastSentId(jid, newId) {
  db.prepare('UPDATE users SET last_sent_id = ? WHERE jid = ?').run(newId, jid);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

module.exports = {
  db,
  insertAyat,
  countAyat,
  getNextAyatForUser,
  getOrCreateUser,
  setUserState,
  getUserState,
  updateLastSentId,
  getAllUsers,
  isUserRegistered,
  registerUser,
  setUserName,
  setUserLocation,
  getUserName,
};