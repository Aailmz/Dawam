// Jalankan: node check_images.js
// Cek apakah semua 900 pasang gambar (arab_0001..0900, indo_0001..0900)
// ada di folder images/, dan cocokkan juga dengan isi tabel 'bacaan' di db.

const fs = require('fs');
const path = require('path');
const { countBacaan, getBacaanById } = require('./db');

const imagesDir = path.join(__dirname, 'images');

console.log('=== CEK FOLDER IMAGES ===\n');

if (!fs.existsSync(imagesDir)) {
  console.log('❌ Folder images/ belum ada. Buat folder ini dan taruh semua file gambar di situ.');
  process.exit(1);
}

const fileHilang = [];
const totalExpected = 900;

for (let id = 1; id <= totalExpected; id++) {
  const paddedId = String(id).padStart(4, '0');
  const arabPath = path.join(imagesDir, `arab_${paddedId}.jpg`);
  const indoPath = path.join(imagesDir, `indo_${paddedId}.jpg`);

  if (!fs.existsSync(arabPath)) fileHilang.push(`arab_${paddedId}.jpg`);
  if (!fs.existsSync(indoPath)) fileHilang.push(`indo_${paddedId}.jpg`);
}

if (fileHilang.length === 0) {
  console.log(`✅ Semua ${totalExpected * 2} file gambar (arab + indo) lengkap di images/.`);
} else {
  console.log(`❌ Ada ${fileHilang.length} file yang HILANG dari images/:\n`);
  // Tampilkan maksimal 30 biar tidak membanjiri terminal, sisanya diringkas
  fileHilang.slice(0, 30).forEach((f) => console.log(`  - ${f}`));
  if (fileHilang.length > 30) {
    console.log(`  ... dan ${fileHilang.length - 30} file lainnya.`);
  }
}

console.log('\n=== CEK DATABASE (tabel bacaan) ===\n');

const totalDiDb = countBacaan();
console.log(`Total baris di tabel bacaan: ${totalDiDb} / ${totalExpected}`);

if (totalDiDb === 0) {
  console.log('⚠️  Tabel bacaan masih kosong. Jalankan "node seed_bacaan.js" dulu setelah data di seed_bacaan.js diisi lengkap.');
} else if (totalDiDb < totalExpected) {
  console.log(`⚠️  Data di seed_bacaan.js belum lengkap (masih ${totalDiDb}/${totalExpected}).`);
} else {
  // Cek silang: untuk tiap row di db, path_arab/path_indo yang tercatat harus benar-benar ada filenya
  console.log('\nMencocokkan path di database dengan file fisik...');
  let mismatchCount = 0;
  for (let id = 1; id <= totalExpected; id++) {
    const row = getBacaanById(id);
    if (!row) continue;
    const arabFullPath = path.join(__dirname, row.path_arab);
    const indoFullPath = path.join(__dirname, row.path_indo);
    if (!fs.existsSync(arabFullPath) || !fs.existsSync(indoFullPath)) {
      mismatchCount++;
    }
  }
  if (mismatchCount === 0) {
    console.log('✅ Semua path di database cocok dengan file fisik yang ada.');
  } else {
    console.log(`❌ Ada ${mismatchCount} baris di database yang path gambarnya tidak ketemu filenya.`);
  }
}

console.log('\n=== KESIMPULAN ===');
if (fileHilang.length === 0 && totalDiDb === totalExpected) {
  console.log('🎉 Semua siap! Gambar lengkap dan data database lengkap 900 baris.');
} else {
  console.log('⚠️  Masih ada yang perlu dibereskan sebelum bot dijalankan ke user sungguhan (lihat detail di atas).');
}