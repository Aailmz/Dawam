const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { getRandomAyat } = require('./db');

// GANTI nomor ini dengan nomor WA tujuan test (format: 62xxx@s.whatsapp.net)
const TARGET_NUMBER = '6281993676677@s.whatsapp.net'; // <-- ganti ini

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // akan di-deprecate tapi masih jalan, kita handle manual juga di bawah
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan QR code ini dengan WhatsApp kamu (Linked Devices):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnect:', shouldReconnect);
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('\n✅ Berhasil terkoneksi ke WhatsApp!\n');
      console.log('Bot siap. Ketik "kirim" di terminal ini untuk trigger kirim bacaan Quran manual.\n');
    }
  });

  // Listener: baca pesan yang masuk dari user
  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return; // skip pesan kosong / pesan dari diri sendiri

    const sender = message.key.remoteJid;
    const text =
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      '';

    console.log(`\n📩 Pesan masuk dari ${sender}: "${text}"`);

    // Contoh respon sederhana
    if (text.toLowerCase() === 'halo') {
      await sock.sendMessage(sender, { text: 'Halo juga! Dawam bot aktif.' });
    }
  });

  // Fungsi buat kirim bacaan Quran manual (trigger via terminal)
  global.kirimBacaanManual = async (targetJid = TARGET_NUMBER) => {
    const data = getRandomAyat();

    if (!data) {
      console.log('⚠️  Database kosong. Jalankan `node seed.js` dulu untuk isi data.');
      return;
    }

    console.log(`Mengirim: Juz ${data.juz}, Halaman ${data.halaman} -> ${data.image_path}`);

    try {
      await sock.sendMessage(targetJid, {
        image: { url: path.join(__dirname, data.image_path) },
        caption: `Bacaan hari ini - Juz ${data.juz}, Halaman ${data.halaman}`,
      });
      console.log('✅ Berhasil terkirim!');
    } catch (err) {
      console.error('❌ Gagal kirim:', err.message);
    }
  };

  return sock;
}

startBot();

// Trigger manual via input terminal
process.stdin.on('data', async (data) => {
  const input = data.toString().trim();
  if (input === 'kirim') {
    if (global.kirimBacaanManual) {
      await global.kirimBacaanManual();
    } else {
      console.log('Bot belum siap, tunggu koneksi dulu.');
    }
  }
});