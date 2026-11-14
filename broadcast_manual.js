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
  `Mau kasih kabar baik nih 😊\n\n` +
  `Setelah kemarin ada migrasi besar ke skema Mushaf Madinah dan beberapa dari kalian sempat ngerasain progress yang nyangkut, kartu yang gagal terkirim, atau keliatan aneh, alhamdulillah semuanya sudah dirapihin dan dicek ulang satu-satu 🤍\n\n` +
  `Kalau kemarin pas ada gangguan kalian sempat disaranin baca dari mushaf sendiri dulu dan lapor manual ke Dawam, sekarang udah boleh balik ke kartu kayak biasa kok, tinggal bilang aja: _"kartu lagi aja"_ ke Dawam di chat pribadi 😊\n\n` +
  `Oh iya, sekalian diingetin lagi ya, Dawam sekarang fleksibel banget, semua fitur (reminder sholat, tawaran tilawah, bentuk bacaan kartu/reminder teks, Al-Kahfi, dll) bisa kamu atur sendiri sesuai yang paling nyaman buat kamu. Mau tetap pakai kartu, mau pindah ke reminder teks aja, dua-duanya sah-sah aja, tinggal bilang ke Dawam pakai bahasa biasa 😊\n\n` +
  `Mau cek pengaturanmu sekarang gimana? Tinggal tanya aja: _"pengaturanku gimana?"_ nanti Dawam kasih liat semuanya.\n\n` +
  `Makasih banyak buat yang udah sabar dan mau lapor pas nemu yang kerasa ganjil kemarin, itu sangat membantu Dawam buat benerin satu-satu 🙏\n\n` +
  `Kalau masih ada yang kerasa belum pas, tetap boleh banget lapor di grup ini ya.\n\n` +
  `Semoga tilawah kita semua tetap istiqomah ya. Barakallahu fiikum 🌙`;
  
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