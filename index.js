const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const path = require('path');
const {
  getNextAyatForUser,
  setUserState,
  getUserState,
  updateLastSentId,
  getAllUsers,
  getOrCreateUser,
  isUserRegistered,
  registerUser,
} = require('./db');

// ========== KONFIGURASI ==========

const JEDA_TAWARAN_MS = 1 * 60 * 1000; // 1 menit (prototype)

// Jadwal waktu sholat (hardcode, format 24 jam)
// Format cron: 'menit jam * * *'
const JADWAL_SHOLAT = {
  subuh: { jam: 4, menit: 20 },
  dzuhur: { jam: 11, menit: 44 },
  ashar: { jam: 14, menit: 47 },
  maghrib: { jam: 17, menit: 49 },
  isya: { jam: 18, menit: 55 },
};

// Ambil semua user yang SUDAH aktivasi (chat "dawam") dari database.
// Dipanggil tiap kali mau broadcast reminder, jadi otomatis update
// kalau ada user baru yang aktivasi.
function getRegisteredTargets() {
  return getAllUsers()
    .filter((u) => u.is_registered === 1)
    .map((u) => u.jid);
}

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

const PESAN_SELAMAT_DATANG =
  'Assalamu\'alaikum warahmatullahi wabarakatuh 🌙\n\nSelamat datang di *Dawam* — teman harianmu untuk istiqomah shalat dan tilawah Al-Qur\'an.\n\nMulai sekarang, Dawam akan mengingatkanmu di setiap waktu shalat dan menemanimu tilawah sedikit demi sedikit, tanpa beban.\n\n"Sebaik-baik amalan di sisi Allah adalah yang dikerjakan secara terus-menerus (dawam), walaupun sedikit." (HR. Bukhari & Muslim)\n\nBarakallahu fiik, Sahabat Dawam 🤍';

const KEYWORD_AKTIVASI = 'dawam';

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
      setupScheduler();
      printHelp();
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return;

    // Baileys versi baru kadang ngirim remoteJid sebagai @lid (linked id/privacy id)
    // bukan JID asli @s.whatsapp.net. Kita normalisasi: kalau ada remoteJidAlt
    // atau participant yang formatnya @s.whatsapp.net, pakai itu sebagai identitas utama.
    const sender = normalizeJid(message);
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

// ========== NORMALISASI JID ==========

// WhatsApp sekarang kadang pakai @lid (privacy-preserving linked ID) sebagai remoteJid,
// bukan nomor asli @s.whatsapp.net. Fungsi ini coba ambil JID "asli" kalau tersedia,
// supaya state/progress yang disimpan pas kirim reminder (pakai @s.whatsapp.net)
// nyambung sama pesan balasan yang masuk (yang mungkin keformat @lid).
function normalizeJid(message) {
  const remoteJid = message.key.remoteJid;

  // Baileys versi baru biasanya nyediain field senderPn / remoteJidAlt kalau
  // remoteJid-nya berupa @lid, berisi nomor asli dalam format @s.whatsapp.net
  const altJid =
    message.key.senderPn || // beberapa versi pakai field ini
    message.key.remoteJidAlt ||
    null;

  if (remoteJid && remoteJid.endsWith('@lid') && altJid) {
    return altJid;
  }

  return remoteJid;
}

// ========== HANDLER PESAN MASUK ==========

async function handleIncomingMessage(jid, text) {
  // Cek dulu: apakah user belum terdaftar dan ngirim keyword aktivasi?
  if (!isUserRegistered(jid)) {
    if (text === KEYWORD_AKTIVASI) {
      registerUser(jid);
      setUserState(jid, 'IDLE');
      await sock.sendMessage(jid, { text: PESAN_SELAMAT_DATANG });
      console.log(`✅ User baru teraktivasi: ${jid}`);
    } else {
      console.log(`(User belum terdaftar, bukan keyword aktivasi, diabaikan: "${text}")`);
    }
    return; // user belum terdaftar, flow lain (konfirmasi ngaji dll) belum berlaku
  }

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

// ========== SCHEDULER OTOMATIS ==========

function setupScheduler() {
  for (const [namaWaktu, jadwal] of Object.entries(JADWAL_SHOLAT)) {
    const cronExpr = `${jadwal.menit} ${jadwal.jam} * * *`; // tiap hari, jam:menit tertentu

    cron.schedule(cronExpr, async () => {
      console.log(`\n⏰ Waktu ${namaWaktu} tiba (${jadwal.jam}:${String(jadwal.menit).padStart(2, '0')}). Mengirim reminder otomatis...`);
      const targets = getRegisteredTargets();
      if (targets.length === 0) {
        console.log('⚠️  Belum ada user yang teraktivasi, reminder dilewati.');
        return;
      }
      for (const jid of targets) {
        await kirimReminderSholat(namaWaktu, jid);
      }
    });

    console.log(`🕒 Scheduler ${namaWaktu} diset jam ${jadwal.jam}:${String(jadwal.menit).padStart(2, '0')}`);
  }
}

// ========== COMMAND MANUAL VIA TERMINAL ==========

function printHelp() {
  console.log('Bot siap.');
  console.log(`Catatan: user harus chat "${KEYWORD_AKTIVASI}" dulu dari WhatsApp-nya supaya teraktivasi.\n`);
  console.log('Command yang bisa dipakai di terminal ini:');
  console.log('  subuh   -> trigger reminder Subuh ke semua user yang sudah aktivasi');
  console.log('  dzuhur  -> trigger reminder Dzuhur ke semua user yang sudah aktivasi');
  console.log('  ashar   -> trigger reminder Ashar ke semua user yang sudah aktivasi');
  console.log('  maghrib -> trigger reminder Maghrib ke semua user yang sudah aktivasi');
  console.log('  isya    -> trigger reminder Isya ke semua user yang sudah aktivasi');
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
    const targets = getRegisteredTargets();
    if (targets.length === 0) {
      console.log('⚠️  Belum ada user yang teraktivasi (chat "dawam" dulu dari WhatsApp).');
      return;
    }
    for (const jid of targets) {
      await kirimReminderSholat(input, jid);
    }
  } else if (input === 'help') {
    printHelp();
  } else if (input) {
    console.log(`Command "${input}" tidak dikenali. Ketik "help" untuk lihat daftar command.`);
  }
});

startBot();