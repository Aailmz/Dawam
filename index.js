const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const {
  getNextAyatForUser,
  setUserState,
  getUserState,
  updateLastSentId,
  getAllUsers,
  getOrCreateUser,
} = require('./db');

// ========== KONFIGURASI ==========

// Daftar nomor yang mau dikirimin reminder (format: 62xxx@s.whatsapp.net)
// Prototype: hardcode dulu, nanti bisa diganti ambil dari tabel users otomatis
const TARGET_NUMBERS = [
  '628123456789@s.whatsapp.net', // <-- ganti ini dengan nomor kamu
];

const JEDA_TAWARAN_MS = 1 * 60 * 1000; // 1 menit (prototype)

// Pesan-pesan islami
const PESAN_REMINDER_SHOLAT = {
  subuh: 'Assalamu\'alaikum 🌙\nWaktu Subuh telah tiba. Yuk, mulai hari dengan sujud pertama kita kepada Allah ﷻ.\n\n"Dan dirikanlah shalat, sesungguhnya shalat itu mencegah dari (perbuatan-perbuatan) keji dan mungkar." (QS. Al-Ankabut: 45)',
  dzuhur: 'Assalamu\'alaikum ☀️\nWaktu Dzuhur telah tiba. Mari sejenak rehat dari aktivitas untuk menghadap Allah ﷻ.',
  ashar: 'Assalamu\'alaikum 🌤️\nWaktu Ashar telah tiba. Jangan sampai terlewat, Sahabat Dawam.',
  maghrib: 'Assalamu\'alaikum 🌆\nWaktu Maghrib telah tiba. Saatnya berhenti sejenak dan kembali mengingat-Nya.',
  isya: 'Assalamu\'alaikum 🌃\nWaktu Isya telah tiba. Tutup hari ini dengan shalat dan doa terbaik.',
};

const PESAN_TAWARAN_NGAJI =
  'Semoga shalatnya diterima Allah ﷻ 🤲\n\nSahabat Dawam, sudah siap lanjut tilawah hari ini? Yuk sisihkan sedikit waktu untuk membaca Al-Qur\'an 📖\n\nBalas *"ya"* untuk lanjut membaca, atau *"nanti"* kalau belum sempat.';

const PESAN_SETELAH_YA_TEMPLATE = (juz, halaman) =>
  `Barakallahu fiik, semoga menjadi pemberat timbangan kebaikan 🤍\n\nIni bacaan untukmu (Juz ${juz}, halaman ${halaman}):`;

const PESAN_SETELAH_TIDAK =
  'Tidak apa-apa, Sahabat 🤍 Semoga ada waktu lain untuk kembali dekat dengan Al-Qur\'an hari ini.\n\n"Sebaik-baik amalan adalah yang dilakukan secara rutin meskipun sedikit." (HR. Bukhari & Muslim)\n\nDawam akan selalu ada menemanimu, kapan pun kamu siap 🌙';

const PESAN_TIDAK_DIMENGERTI =
  'Maaf, Dawam belum paham maksudnya 🙏 Balas dengan *"ya"* atau *"nanti"* ya, Sahabat.';

// ========== BOT LOGIC ==========

let sock;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
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
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('\n✅ Berhasil terkoneksi ke WhatsApp!\n');
      printHelp();
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return;

    const sender = message.key.remoteJid;
    const text = (
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      ''
    )
      .trim()
      .toLowerCase();

    console.log(`\n📩 Pesan masuk dari ${sender}: "${text}"`);

    await handleIncomingMessage(sender, text);
  });

  return sock;
}

// ========== HANDLER PESAN MASUK ==========

async function handleIncomingMessage(jid, text) {
  const state = getUserState(jid);

  if (state === 'WAITING_CONFIRM') {
    const jawabanYa = ['ya', 'iya', 'mau', 'yes', 'y', 'boleh', 'siap'];
    const jawabanTidak = ['nanti', 'tidak', 'ga', 'gak', 'engga', 'enggak', 'no', 'belum'];

    if (jawabanYa.includes(text)) {
      await kirimBacaan(jid);
      setUserState(jid, 'IDLE');
    } else if (jawabanTidak.includes(text)) {
      await sock.sendMessage(jid, { text: PESAN_SETELAH_TIDAK });
      setUserState(jid, 'IDLE');
    } else {
      // Ga ngerti jawaban user, tetap hidupin percakapan
      await sock.sendMessage(jid, { text: PESAN_TIDAK_DIMENGERTI });
      // state tetap WAITING_CONFIRM, biar user bisa coba jawab lagi
    }
  } else {
    // Di luar state nunggu konfirmasi, bisa ditambah respon default lain di sini nanti
    console.log(`(Pesan di luar flow aktif, diabaikan untuk sekarang)`);
  }
}

// ========== FUNGSI-FUNGSI TRIGGER ==========

async function kirimReminderSholat(waktuSholat, jid) {
  const pesan = PESAN_REMINDER_SHOLAT[waktuSholat];
  if (!pesan) {
    console.log(`⚠️  Waktu sholat "${waktuSholat}" tidak dikenali.`);
    return;
  }

  getOrCreateUser(jid);
  await sock.sendMessage(jid, { text: pesan });
  console.log(`✅ Reminder ${waktuSholat} terkirim ke ${jid}`);

  console.log(`⏳ Menjadwalkan tawaran ngaji dalam ${JEDA_TAWARAN_MS / 1000} detik...`);
  setTimeout(() => kirimTawaranNgaji(jid), JEDA_TAWARAN_MS);
}

async function kirimTawaranNgaji(jid) {
  await sock.sendMessage(jid, { text: PESAN_TAWARAN_NGAJI });
  setUserState(jid, 'WAITING_CONFIRM');
  console.log(`✅ Tawaran ngaji terkirim ke ${jid}, menunggu balasan...`);
}

async function kirimBacaan(jid) {
  const data = getNextAyatForUser(jid);

  if (!data) {
    await sock.sendMessage(jid, {
      text: 'Maaf, data bacaan belum tersedia saat ini 🙏',
    });
    return;
  }

  try {
    await sock.sendMessage(jid, {
      image: { url: path.join(__dirname, data.image_path) },
      caption: PESAN_SETELAH_YA_TEMPLATE(data.juz, data.halaman),
    });
    updateLastSentId(jid, data.id);
    console.log(`✅ Bacaan terkirim ke ${jid}: Juz ${data.juz}, Halaman ${data.halaman}`);
  } catch (err) {
    console.error('❌ Gagal kirim bacaan:', err.message);
  }
}

// ========== COMMAND MANUAL VIA TERMINAL ==========

function printHelp() {
  console.log('Bot siap. Command yang bisa dipakai di terminal ini:');
  console.log('  subuh   -> trigger reminder Subuh ke semua target');
  console.log('  dzuhur  -> trigger reminder Dzuhur ke semua target');
  console.log('  ashar   -> trigger reminder Ashar ke semua target');
  console.log('  maghrib -> trigger reminder Maghrib ke semua target');
  console.log('  isya    -> trigger reminder Isya ke semua target');
  console.log('  help    -> tampilkan daftar command ini lagi\n');
}

process.stdin.on('data', async (data) => {
  const input = data.toString().trim().toLowerCase();
  const waktuSholatValid = ['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya'];

  if (waktuSholatValid.includes(input)) {
    if (!sock) {
      console.log('Bot belum siap, tunggu koneksi dulu.');
      return;
    }
    for (const jid of TARGET_NUMBERS) {
      await kirimReminderSholat(input, jid);
    }
  } else if (input === 'help') {
    printHelp();
  } else if (input) {
    console.log(`Command "${input}" tidak dikenali. Ketik "help" untuk lihat daftar command.`);
  }
});

startBot();