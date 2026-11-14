const { db, getUser } = require('./db');

// Parse "Al-Baqarah 17-20" atau "Al-Baqarah 17" -> { surat: "Al-Baqarah", ayat: 20 (ambil ayat TERAKHIR) }
// Juga menangani lintas-surah "Al-Ma'arij 36 - Nuh 4" -> ambil bagian setelah " - " terakhir sebagai acuan.
function parseSuratAyatAkhir(teks) {
  if (!teks) return null;
  let bersih = String(teks).trim();
  if (!bersih) return null;

  // Kalau lintas-surah (ada " - "), ambil bagian setelah tanda itu sebagai posisi akhir.
  const bagianLintas = bersih.split(' - ');
  bersih = bagianLintas[bagianLintas.length - 1].trim();

  const match = bersih.match(/^(.+?)\s+(\d+)(?:-(\d+))?$/);
  if (!match) return null;

  const surat = match[1].trim();
  const ayatAkhir = match[3] ? parseInt(match[3], 10) : parseInt(match[2], 10);
  return { surat, ayat: ayatAkhir };
}

function cariUrutanTerdekat(surat, ayat) {
  // Prioritas 1: kartu yang surat_selesai-nya persis cocok dan ayat_selesai >= ayat.
  let row = db
    .prepare(`
      SELECT urutan FROM bacaan
      WHERE surat_selesai = ? AND ayat_selesai >= ?
      ORDER BY urutan ASC LIMIT 1
    `)
    .get(surat, ayat);
  if (row) return row.urutan;

  // Prioritas 2: kartu yang surat_mulai-nya cocok (jaga-jaga kalau surat itu cuma muncul di kolom mulai).
  row = db
    .prepare(`
      SELECT urutan FROM bacaan
      WHERE surat_mulai = ? AND ayat_mulai >= ?
      ORDER BY urutan ASC LIMIT 1
    `)
    .get(surat, ayat);
  if (row) return row.urutan;

  // Prioritas 3: cocokkan nama surat apa adanya (LIKE), ambil kartu pertama surat itu.
  row = db
    .prepare(`SELECT urutan FROM bacaan WHERE surat_mulai LIKE ? ORDER BY urutan ASC LIMIT 1`)
    .get(`%${surat}%`);
  return row ? row.urutan : null;
}

function main() {
  const users = db
    .prepare(`SELECT jid FROM users WHERE is_registered = 1`)
    .all();

  const hasil = { berhasil: 0, dilewati: 0, gagal: 0 };

  for (const u of users) {
    const jid = u.jid;

    const logTerakhir = db
      .prepare(`
        SELECT surat_ayat_akhir FROM log_bacaan_harian
        WHERE user_jid = ? AND surat_ayat_akhir IS NOT NULL AND surat_ayat_akhir != ''
        ORDER BY tanggal DESC LIMIT 1
      `)
      .get(jid);

    if (!logTerakhir) {
      hasil.dilewati++;
      continue;
    }

    const parsed = parseSuratAyatAkhir(logTerakhir.surat_ayat_akhir);
    if (!parsed) {
      hasil.gagal++;
      continue;
    }

    const urutanBaru = cariUrutanTerdekat(parsed.surat, parsed.ayat);
    if (!urutanBaru) {
      hasil.gagal++;
      continue;
    }

    db.prepare(`UPDATE users SET last_sent_bacaan_id = ?, start_bacaan_id = ? WHERE jid = ?`)
      .run(urutanBaru, urutanBaru, jid);
    hasil.berhasil++;
  }

  console.log(`Migrasi selesai. Berhasil: ${hasil.berhasil}, dilewati (tidak ada log): ${hasil.dilewati}, gagal parse/cocok: ${hasil.gagal}.`);
}

main();