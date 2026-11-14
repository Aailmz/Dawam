require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { getAllGroupsAktif } = require('./db');

// ========== PESAN PENGUMUMAN ==========
// Diawali salam karena ini pesan baru/broadcast, bukan balasan ke siapapun.

const PESAN_PENGUMUMAN_FITUR_BERHENTI =
  `Assalamu'alaikum, Sahabat Dawam semua 🤍\n\n` +
  `Ada fitur baru nih, Dawam sekarang lebih fleksibel, kamu bisa atur sendiri mana yang mau nyala/mati 😊\n\n` +
  `Jadi kalau ada bagian yang kerasa kurang pas sama kebiasaanmu, sekarang gak perlu dipaksain lagi. Tinggal bilang aja ke Dawam di chat pribadi pakai bahasa biasa, gak ada format khusus kok.\n\n` +
  `Ini yang bisa kamu atur:\n\n` +
  `1️⃣ *Reminder sholat 5 waktu*\n` +
  `Pengingat pas masuk waktu Subuh, Dzuhur, Ashar, Maghrib, Isya.\n` +
  `Mau matiin? bilang aja: _"gausah reminder sholat ya"_\n\n` +
  `2️⃣ *Tawaran tilawah*\n` +
  `Ini yang muncul abis reminder sholat, nanya "udah siap lanjut baca belum". Kalau dimatiin, reminder sholat tetap jalan, cuma gak ditawarin baca lagi.\n` +
  `Bilang: _"reminder sholat aja, gausah tawarin baca"_\n\n` +
  `3️⃣ *Bentuk bacaannya: kartu gambar atau reminder teks aja*\n` +
  `Defaultnya Dawam kirim kartu (gambar ayat Arab/terjemah). Tapi kalau kamu lebih suka baca dari mushaf/app sendiri dan cuma butuh diingetin, bisa diganti jadi reminder teks doang (gak ada gambar, progress gak otomatis kehitung).\n` +
  `Bilang: _"gausah kartu, reminder aja"_ (balik ke kartu: _"kartu lagi aja"_)\n\n` +
  `📌 Kalau kamu pilih mode reminder ini, progressnya BUKAN dihitung otomatis lagi ya. Jadi abis baca, tinggal lapor ke Dawam udah sampai mana, misal: _"udah sampai Al-Baqarah ayat 82"_, nanti Dawam yang hitungin progressnya otomatis dari situ.\n\n` +
  `⚠️ Penting: meskipun bacanya pakai mushaf/app sendiri, urutan bacanya tetap ngikutin panduan/alur Dawam ya (bukan loncat-loncat bebas pilih surat sendiri), supaya progress dan posisi kamu ketemu/sinkron pas dilaporkan. Kalau posisi yang kamu sebut kelihatan aneh/gak masuk akal (misal mundur dari posisi sebelumnya), Dawam bakal tanya ulang dulu biar datanya tetap akurat, bukan main catat aja.\n\n` +
  `4️⃣ *Tawaran baca Al-Kahfi tiap Jumat pagi*\n` +
  `Kalau gak butuh pengingat khusus ini, bisa dimatiin.\n` +
  `Bilang: _"gausah al kahfi"_\n\n` +
  `5️⃣ *Reminder khusus sholat Jumat* (buat Akhi aja)\n` +
  `Pengingat 15 menit sebelum Dzuhur, khusus hari Jumat.\n` +
  `Bilang: _"gausah reminder jumat"_\n\n` +
  `Semua fitur di atas bisa dinyalain lagi kapan aja kok, tinggal bilang sebaliknya (misal "nyalain lagi reminder sholat").\n\n` +
  `Mau cek pengaturanmu sekarang gimana? Tinggal tanya aja: _"pengaturanku gimana?"_ nanti Dawam kasih liat semuanya.\n\n` +
  `Semoga ini bikin Dawam makin nyaman dipakai sesuai ritme ibadah masing-masing ya 🤍 Barakallahu fiikum 🌙`;
  
// ========== HELPER ==========

function tunggu(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jalankanBroadcast(sock) {
  const grupAktif = getAllGroupsAktif();

  if (grupAktif.length === 0) {
    console.log('⚠️  Tidak ada grup aktif, tidak ada yang di-broadcast.');
    return;
  }

  console.log(`📣 Mulai broadcast ke ${grupAktif.length} grup aktif...\n`);

  let sukses = 0;
  let gagal = 0;

  for (const g of grupAktif) {
    try {
      await sock.sendMessage(g.jid, { text: PESAN_PENGUMUMAN_FITUR_BERHENTI });
      console.log(`✅ Terkirim ke grup ${g.jid} (${g.nama || 'tanpa nama'})`);
      sukses++;
    } catch (err) {
      console.error(`❌ Gagal kirim ke grup ${g.jid}:`, err.message);
      gagal++;
    }
    // Jeda antar grup biar tidak kena rate-limit/flagged spam oleh WhatsApp.
    await tunggu(2000);
  }

  console.log(`\n📊 Selesai. Sukses: ${sukses}, Gagal: ${gagal}, Total grup: ${grupAktif.length}`);
}

// ========== BOOTSTRAP KONEKSI (reuse sesi auth yang sama dengan bot utama) ==========

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus saat broadcast. Reconnect:', shouldReconnect);
      if (shouldReconnect) {
        start();
      } else {
        process.exit(1);
      }
    } else if (connection === 'open') {
      console.log('✅ Terkoneksi ke WhatsApp. Menjalankan broadcast...\n');
      // Jeda kecil supaya socket benar-benar siap sebelum kirim batch pertama.
      await tunggu(2000);
      await jalankanBroadcast(sock);
      console.log('\n🏁 Broadcast selesai, keluar.');
      process.exit(0);
    }
  });
}

start();