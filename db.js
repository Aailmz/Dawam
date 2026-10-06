const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'dawam.db'));

// Bikin tabel kalau belum ada
db.exec(`
  CREATE TABLE IF NOT EXISTS ayat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    juz INTEGER,
    halaman INTEGER,
    image_path TEXT NOT NULL
  )
`);

// Fungsi: ambil 1 row random dari tabel ayat
function getRandomAyat() {
  const row = db.prepare('SELECT * FROM ayat ORDER BY RANDOM() LIMIT 1').get();
  return row;
}

// Fungsi: insert data ayat baru (dipakai buat seeding)
function insertAyat(juz, halaman, imagePath) {
  const stmt = db.prepare('INSERT INTO ayat (juz, halaman, image_path) VALUES (?, ?, ?)');
  return stmt.run(juz, halaman, imagePath);
}

// Fungsi: cek berapa banyak data yang ada
function countAyat() {
  const row = db.prepare('SELECT COUNT(*) as total FROM ayat').get();
  return row.total;
}

module.exports = { db, getRandomAyat, insertAyat, countAyat };