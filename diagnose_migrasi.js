const { db } = require('./db');

function parseSuratAyatAkhir(teks) {
  if (!teks) return null;
  let bersih = String(teks).trim();
  if (!bersih) return null;
  const bagianLintas = bersih.split(' - ');
  bersih = bagianLintas[bagianLintas.length - 1].trim();
  const match = bersih.match(/^(.+?)\s+(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const surat = match[1].trim();
  const ayatAkhir = match[3] ? parseInt(match[3], 10) : parseInt(match[2], 10);
  return { surat, ayat: ayatAkhir };
}

function cariUrutanTerdekat(surat, ayat) {
  let row = db.prepare(`SELECT urutan FROM bacaan WHERE surat_selesai = ? AND ayat_selesai >= ? ORDER BY urutan ASC LIMIT 1`).get(surat, ayat);
  if (row) return row.urutan;
  row = db.prepare(`SELECT urutan FROM bacaan WHERE surat_mulai = ? AND ayat_mulai >= ? ORDER BY urutan ASC LIMIT 1`).get(surat, ayat);
  if (row) return row.urutan;
  row = db.prepare(`SELECT urutan FROM bacaan WHERE surat_mulai LIKE ? ORDER BY urutan ASC LIMIT 1`).get(`%${surat}%`);
  return row ? row.urutan : null;
}

const users = db.prepare(`SELECT jid, name FROM users WHERE is_registered = 1`).all();

for (const u of users) {
  const logTerakhir = db.prepare(`
    SELECT surat_ayat_akhir, tanggal FROM log_bacaan_harian
    WHERE user_jid = ? AND surat_ayat_akhir IS NOT NULL AND surat_ayat_akhir != ''
    ORDER BY tanggal DESC LIMIT 1
  `).get(u.jid);

  if (!logTerakhir) continue; // dilewati, not what we're debugging

  const parsed = parseSuratAyatAkhir(logTerakhir.surat_ayat_akhir);
  if (!parsed) {
    console.log(`❌ PARSE GAGAL | ${u.name || u.jid} | raw="${logTerakhir.surat_ayat_akhir}" | tanggal=${logTerakhir.tanggal}`);
    continue;
  }

  const urutan = cariUrutanTerdekat(parsed.surat, parsed.ayat);
  if (!urutan) {
    console.log(`❌ TIDAK COCOK | ${u.name || u.jid} | raw="${logTerakhir.surat_ayat_akhir}" | parsed_surat="${parsed.surat}" | parsed_ayat=${parsed.ayat}`);
  }
}

console.log('\n✅ Diagnosa selesai.');