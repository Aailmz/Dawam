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
  `Ada kabar baru nih dari Dawam 📣\n\n` +
  `Mulai sekarang, kalau kamu lagi butuh jeda (sibuk, capek, atau alasan apapun) dan mau istirahat dulu dari reminder sholat & tilawah, kamu bisa bilang langsung ke Dawam di chat pribadi, misalnya:\n` +
  `*"aku mau berhenti dulu"* atau *"stop dulu ya"*\n\n` +
  `Dawam akan tanya alasannya dulu, terus reminder bakal berhenti. Tenang aja, progress & data kamu AMAN, nggak hilang 🤍\n\n` +
  `Kalau udah siap lanjut lagi kapanpun itu, tinggal bilang aja ke chat pribadi Dawam:\n` +
  `*"aktifin lagi"* atau *"lanjut lagi"*\n\n` +
  `...dan semuanya bakal jalan lagi dari posisi terakhirmu, nggak perlu onboarding ulang 😊\n\n` +
  `Semoga ini bikin perjalanan tilawah kita makin nyaman ya, tanpa ada beban. Barakallahu fiikum 🌙`;

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