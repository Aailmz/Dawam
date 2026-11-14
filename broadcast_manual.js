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
  `Mau kasih info update nih 😊\n\n` +
  `Mulai sekarang, bacaan di Dawam udah pindah ngikutin pemetaan *Mushaf Madinah* (yang biasa dipakai di mushaf cetak pada umumnya), bukan lagi skema lama.\n\n` +
  `Beberapa hal yang berubah:\n` +
  `- Kartu bacaan sekarang dipecah per kartu kecil ikut ayat dan waqaf, bukan per halaman penuh kayak sebelumnya.\n` +
  `- Jumlah kartu per juz jadi beda-beda (nggak sama rata 30 bagian lagi), soalnya ngikutin panjang-pendeknya ayat di tiap juz.\n` +
  `- Progress dan hitungan pace (persen target harian) sekarang dihitung ulang berdasarkan skema baru ini.\n\n` +
  `Progress tilawah kalian TETAP lanjut dari posisi terakhir ya, bukan direset dari awal lagi. Cuma cara hitung & tampilannya aja yang menyesuaikan skema baru.\n\n` +
  `Karena ini perubahan cukup besar, mohon maaf kalau sewaktu-waktu ada yang kerasa aneh, nyangkut, posisi kelihatan meleset, atau beda dari biasanya 🙏 Kalau nemu hal kayak gitu, tolong banget lapor di grup ini ya, biar bisa langsung dicek dan dibenerin.\n\n` +
  `Makasih banyak udah sabar nemenin Dawam di proses ini 🤍 Semoga tilawah kita tetap istiqomah. Barakallahu fiikum 🌙`;

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