const fs = require('fs');
const path = require('path');
const { insertAyat, countAyat } = require('./db');

// Script ini buat masukin data gambar yang ada di folder images/ ke database
// Asumsi: nama file gambar formatnya bebas, kamu isi manual juz & halaman di bawah

const imagesDir = path.join(__dirname, 'images');

// Cek folder images ada isinya atau ga
if (!fs.existsSync(imagesDir)) {
  console.log('Folder images/ belum ada. Bikin dulu folder images/ dan taruh file gambar di situ.');
  process.exit(1);
}

const files = fs.readdirSync(imagesDir).filter(f => 
  f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png')
);

if (files.length === 0) {
  console.log('Ga ada file gambar di folder images/. Taruh file .jpg/.png di situ dulu.');
  process.exit(1);
}

console.log(`Ditemukan ${files.length} file gambar. Memasukkan ke database...`);

files.forEach((file, index) => {
  // Default: juz & halaman diisi index dulu (sesuaikan manual kalau perlu)
  const juz = 1;
  const halaman = index + 1;
  const imagePath = path.join('images', file);
  
  insertAyat(juz, halaman, imagePath);
  console.log(`  [OK] ${file} -> juz ${juz}, halaman ${halaman}`);
});

console.log(`\nSelesai. Total data di database: ${countAyat()}`);