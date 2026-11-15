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
  `Izin nimbrung ya 🙏\n\n` +
  `Makasih banget buat yang udah lapor soal "ga bisa menuju surah" dan "penghitungan halaman salah" di atas. Dawam bantu infoin kalo memang sempat ada maintenance besar Dawam, jadi kadang ke-reset ke 0/awal mushaf ketimbang ke posisi yang bener 🙏 Sekarang udah mulai bener.\n\n` +
  `Mohon maaf buat yang sempat ngerasain progress-nya kelihatan aneh atau gak nyambung. Kalau ada yang masih terasa salah sampai sekarang, boleh banget lapor lagi di grup ini ya, biar langsung dicek posisinya.\n\n` +
  `Sekalian, Dawam juga mau jelasin biar laporan ke depan makin pas: kalau kalian lapor "udah sampai ayat sekian" tanpa nyebut mulai dari mana, sekarang Dawam bakal tanya dulu buat konfirmasi (misal: "dari posisi terakhir lanjut sampai situ ya?"), jadi gak akan asal catat lagi walau yang disebut keliatannya kurang jelas.\n\n` +
  `Dan kalau kalian ngerasa ada yang salah catat (posisi meleset, dll), sekarang bisa langsung bilang aja ke Dawam di chat pribadi, misal: _"itu salah, harusnya aku di surat X ayat Y"_ -- nanti Dawam konfirmasi dulu baru dibenerin, gampang kok 😊\n\n` +
  `Makasih banyak udah sabar ya, Sahabat Dawam 🤍`;
  
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