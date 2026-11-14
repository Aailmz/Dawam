// fix_5_users.js
const { db } = require('./db');

function setPosisi(nama, surat, ayat) {
  const row = db.prepare(`
    SELECT urutan FROM bacaan WHERE surat_selesai = ? AND ayat_selesai >= ?
    ORDER BY urutan ASC LIMIT 1
  `).get(surat, ayat);
  if (!row) {
    console.log(`❌ Tetap tidak ketemu untuk ${nama} (${surat} ${ayat})`);
    return;
  }
  const result = db.prepare(`UPDATE users SET last_sent_bacaan_id = ?, start_bacaan_id = ? WHERE name = ?`)
    .run(row.urutan, row.urutan, nama);
  console.log(`✅ ${nama} -> urutan ${row.urutan} (${result.changes} baris diupdate)`);
}

setPosisi('Mirza', "Al-'Ankabut", 13);
setPosisi('Nur Hanafi', 'Al-Infithar', 19);
setPosisi('Irma', 'Ghafir', 5);
setPosisi('Fikie', 'Al-Kautsar', 3);
setPosisi('Diyah', 'At-Takatsur', 8);