const path = require('path');
const XLSX = require('xlsx');
const { insertBacaan, countBacaan, db } = require('./db');

// ======================================================================
// SEED BARU — berbasis kode kartu mushaf Madinah (kode/urutan), bukan lagi
// per waktu sholat. Sumber: sheet "Ikut Ayat dan Waqaf" + "Ayat Terpotong"
// dari file Pemetaan_Mushaf_Madinah_3_Bagian_per_Halaman.xlsx.
//
// Jalankan: node seed_bacaan.js /path/ke/Pemetaan_Mushaf_Madinah_3_Bagian_per_Halaman.xlsx
// (atau taruh file itu satu folder dengan script ini dan jalankan tanpa argumen)
// ======================================================================

const EXCEL_PATH = process.argv[2] || path.join(__dirname, 'Pemetaan_Mushaf_Madinah_3_Bagian_per_Halaman.xlsx');

// Parse "Al-Baqarah 85 (kata 22)" atau "Al-Baqarah 85" -> { surat: "Al-Baqarah", ayat: 85 }
// Suffix "(kata N)" (muncul di 32 baris ayat terpotong) dibuang -- tidak relevan
// untuk pencarian by-ayat, yang penting nomor ayatnya.
function parseSuratAyat(teks) {
  if (!teks) return null;
  const bersih = String(teks).replace(/\s*\(kata\s+\d+\)\s*$/i, '').trim();
  const match = bersih.match(/^(.+?)\s+(\d+)$/);
  if (!match) return null;
  return { surat: match[1].trim(), ayat: parseInt(match[2], 10) };
}

// Gabungan tampilan "Mulai–Selesai" buat caption kartu (surat_ayat), dibuat SENDIRI
// dari surat_mulai/ayat_mulai/surat_selesai/ayat_selesai yang sudah diparsing --
// bukan dicopy mentah dari kolom Excel, supaya konsisten formatnya dan tidak
// terbawa suffix "(kata N)".
function buatLabelSuratAyat(suratMulai, ayatMulai, suratSelesai, ayatSelesai) {
  if (suratMulai === suratSelesai) {
    if (ayatMulai === ayatSelesai) return `${suratMulai} ${ayatMulai}`;
    return `${suratMulai} ${ayatMulai}-${ayatSelesai}`;
  }
  // Lintas surah (contoh: "Al-Ma'arij 36 - Nuh 4")
  return `${suratMulai} ${ayatMulai} - ${suratSelesai} ${ayatSelesai}`;
}

function bacaExcel() {
  console.log(`Membaca ${EXCEL_PATH} ...`);
  const wb = XLSX.readFile(EXCEL_PATH);

  const shIkutAyat = wb.Sheets['Ikut Ayat dan Waqaf'];
  if (!shIkutAyat) {
    throw new Error('Sheet "Ikut Ayat dan Waqaf" tidak ditemukan di file Excel.');
  }
  const baris = XLSX.utils.sheet_to_json(shIkutAyat, { defval: null });

  const shAyatTerpotong = wb.Sheets['Ayat Terpotong'];
  const barisTerpotong = shAyatTerpotong
    ? XLSX.utils.sheet_to_json(shAyatTerpotong, { defval: null })
    : [];
  const kodeTerpotongSet = new Set(barisTerpotong.map((r) => String(r['Kode kartu']).trim()));

  return { baris, kodeTerpotongSet };
}

function bangunRows(baris, kodeTerpotongSet) {
  const rows = [];
  const errors = [];

  baris.forEach((r, index) => {
    const posisi = `baris Excel ke-${index + 2} (kode=${r['Kode']})`; // +2: header + 1-index

    const kode = String(r['Kode']).trim();
    const halaman = Number(r['Halaman']);
    const bagian = String(r['Bagian']).trim();
    const juz = Number(r['Juz']);

    const mulaiParsed = parseSuratAyat(r['Mulai']);
    const selesaiParsed = parseSuratAyat(r['Selesai']);

    if (!mulaiParsed) {
      errors.push(`${posisi}: kolom "Mulai" ("${r['Mulai']}") gagal diparse jadi surat+ayat.`);
      return;
    }
    if (!selesaiParsed) {
      errors.push(`${posisi}: kolom "Selesai" ("${r['Selesai']}") gagal diparse jadi surat+ayat.`);
      return;
    }

    const suratAyat = buatLabelSuratAyat(
      mulaiParsed.surat,
      mulaiParsed.ayat,
      selesaiParsed.surat,
      selesaiParsed.ayat
    );

    rows.push({
      kode,
      urutan: index + 1, // urutan global 1..N mengikuti urutan baris di sheet (sudah berurutan sesuai mushaf)
      halaman,
      bagian,
      juz,
      surat_ayat: suratAyat,
      surat_mulai: mulaiParsed.surat,
      ayat_mulai: mulaiParsed.ayat,
      surat_selesai: selesaiParsed.surat,
      ayat_selesai: selesaiParsed.ayat,
      ayat_terpotong: kodeTerpotongSet.has(kode) ? 1 : 0,
    });
  });

  return { rows, errors };
}

function validasiRows(rows) {
  const errors = [];
  const kodeTerlihat = new Set();
  const urutanTerlihat = new Set();

  rows.forEach((row, index) => {
    const posisi = `baris ke-${index + 1} (kode=${row.kode})`;

    if (kodeTerlihat.has(row.kode)) errors.push(`${posisi}: kode duplikat`);
    kodeTerlihat.add(row.kode);

    if (urutanTerlihat.has(row.urutan)) errors.push(`${posisi}: urutan duplikat`);
    urutanTerlihat.add(row.urutan);

    if (row.urutan !== index + 1) {
      errors.push(`${posisi}: urutan tidak berurut, seharusnya ${index + 1}`);
    }
    if (!row.juz || row.juz < 1 || row.juz > 30) {
      errors.push(`${posisi}: juz "${row.juz}" di luar range 1-30`);
    }
    if (!row.halaman || row.halaman < 1 || row.halaman > 604) {
      errors.push(`${posisi}: halaman "${row.halaman}" di luar range 1-604`);
    }
    if (!row.surat_ayat) errors.push(`${posisi}: surat_ayat kosong`);
    if (!row.surat_mulai || !row.ayat_mulai) errors.push(`${posisi}: surat_mulai/ayat_mulai tidak lengkap`);
    if (!row.surat_selesai || !row.ayat_selesai) errors.push(`${posisi}: surat_selesai/ayat_selesai tidak lengkap`);
  });

  return errors;
}

function main() {
  const { baris, kodeTerpotongSet } = bacaExcel();
  console.log(`Ditemukan ${baris.length} baris di sheet "Ikut Ayat dan Waqaf".`);
  console.log(`Ditemukan ${kodeTerpotongSet.size} kode kartu dengan ayat terpotong di sheet "Ayat Terpotong".`);

  const { rows, errors: errorsParsing } = bangunRows(baris, kodeTerpotongSet);

  if (errorsParsing.length > 0) {
    console.log(`\n❌ Ditemukan ${errorsParsing.length} masalah PARSING, seeding DIBATALKAN:\n`);
    errorsParsing.forEach((e) => console.log(`  - ${e}`));
    process.exit(1);
  }

  const errorsValidasi = validasiRows(rows);
  if (errorsValidasi.length > 0) {
    console.log(`\n❌ Ditemukan ${errorsValidasi.length} masalah VALIDASI, seeding DIBATALKAN:\n`);
    errorsValidasi.forEach((e) => console.log(`  - ${e}`));
    process.exit(1);
  }

  console.log(`\n✅ Parsing & validasi lolos. Total ${rows.length} baris siap di-seed.`);

  // Kosongkan dulu tabel supaya seed ini idempotent (bisa dijalankan ulang tanpa
  // bentrok PK/UNIQUE kalau sebelumnya pernah diseed sebagian/gagal di tengah).
  const totalSebelum = countBacaan();
  if (totalSebelum > 0) {
    console.log(`(Tabel bacaan sudah berisi ${totalSebelum} baris, akan dikosongkan dulu sebelum re-seed.)`);
    db.exec('DELETE FROM bacaan');
  }

  const insertSemua = db.transaction((rowsInput) => {
    for (const row of rowsInput) {
      insertBacaan(row);
    }
  });
  insertSemua(rows);

  const total = countBacaan();
  console.log(`\n✅ Selesai. Total baris di tabel bacaan sekarang: ${total}`);

  if (total !== rows.length) {
    console.log(`⚠️  Jumlah di db (${total}) tidak cocok dengan jumlah baris sumber (${rows.length})! Cek ulang.`);
  } else {
    console.log('🎉 Seed berhasil, jumlah sesuai sumber Excel.');
  }

  // Ringkasan cepat per juz, buat sanity-check manual.
  const perJuz = db.prepare('SELECT juz, COUNT(*) as jumlah FROM bacaan GROUP BY juz ORDER BY juz').all();
  console.log('\nJumlah kartu per juz:');
  perJuz.forEach((j) => console.log(`  Juz ${j.juz}: ${j.jumlah} kartu`));

  const jumlahTerpotong = db.prepare('SELECT COUNT(*) as t FROM bacaan WHERE ayat_terpotong = 1').get().t;
  console.log(`\nKartu dengan ayat_terpotong=1: ${jumlahTerpotong} (harus 31, sesuai sheet "Ayat Terpotong")`);
}

main();