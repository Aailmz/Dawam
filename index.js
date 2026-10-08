require('dotenv').config();

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
  setUserName,
  setUserLocation,
  getUserName,
} = require('./db');
const groqAI = require('./groq');

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

const PESAN_TAWARAN_NGAJI_TEMPLATE = (nama) =>
  `Semoga shalatnya diterima Allah ﷻ 🤲\n\n${nama}, sudah siap lanjut tilawah hari ini? Yuk sisihkan sedikit waktu untuk membaca Al-Qur'an 📖\n\nBalas *"ya"* untuk lanjut membaca, atau *"nanti"* kalau belum sempat.`;

const PESAN_SETELAH_YA_TEMPLATE = (juz, halaman) =>
  `Barakallahu fiik, semoga menjadi pemberat timbangan kebaikan 🤍\n\nIni bacaan untukmu (Juz ${juz}, halaman ${halaman}):`;

const PESAN_SETELAH_TIDAK =
  'Tidak apa-apa, Sahabat 🤍 Semoga ada waktu lain untuk kembali dekat dengan Al-Qur\'an hari ini.\n\n"Sebaik-baik amalan adalah yang dilakukan secara rutin meskipun sedikit." (HR. Bukhari & Muslim)\n\nDawam akan selalu ada menemanimu, kapan pun kamu siap 🌙';

const PESAN_TIDAK_DIMENGERTI =
  'Maaf, Dawam belum paham maksudnya 🙏 Balas dengan *"ya"* atau *"nanti"* ya, Sahabat.';

const PESAN_SELAMAT_DATANG =
  'Assalamu\'alaikum warahmatullahi wabarakatuh 🌙\n\nSelamat datang di *Dawam* — teman harianmu untuk istiqomah shalat dan tilawah Al-Qur\'an.\n\nMulai sekarang, Dawam akan mengingatkanmu di setiap waktu shalat dan menemanimu tilawah sedikit demi sedikit, tanpa beban.\n\n"Sebaik-baik amalan di sisi Allah adalah yang dikerjakan secara terus-menerus (dawam), walaupun sedikit." (HR. Bukhari & Muslim)\n\nBarakallahu fiik, Sahabat Dawam 🤍';

const PESAN_TANYA_NAMA =
  'Sebelum lanjut, kenalan dulu yuk 😊\nBoleh kasih tahu Dawam, siapa nama panggilanmu?';

const PESAN_TANYA_LOKASI_TEMPLATE = (nama) =>
  `Senang berkenalan denganmu, ${nama} 🤍\n\nSatu lagi, kamu domisili di kota/daerah mana? Ini supaya Dawam bisa sesuaikan jadwal shalatnya nanti.`;

const PESAN_ONBOARDING_SELESAI_TEMPLATE = (nama, lokasi) =>
  `Siap, ${nama}! Dawam sudah catat domisilimu di ${lokasi} 📍`;

const PESAN_PERKENALAN_PERAN =
  'Sedikit cerita soal Dawam ya 🤍\n\nSetiap hari, aku bakal ingetin kamu pas waktu shalat tiba — nggak lama-lama, cuma pengingat sederhana biar nggak kelewat.\n\nSelepas itu, aku juga bakal nanya apakah kamu mau lanjut tilawah sedikit. Nggak ada paksaan — kalau lagi sibuk atau belum sempat, bilang aja "nanti", aku nggak akan maksa 😊\n\nKalau kamu bilang mau, aku kirimin bacaan lanjutannya, dari halaman terakhir yang udah kamu baca. Pelan-pelan aja, yang penting konsisten.\n\nYuk kita mulai perjalanan ini bareng-bareng, semoga Allah mudahkan 🌙';

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
      setUserState(jid, 'WAITING_NAME');
      await sock.sendMessage(jid, { text: PESAN_SELAMAT_DATANG });
      await sock.sendMessage(jid, { text: PESAN_TANYA_NAMA });
      console.log(`✅ User baru teraktivasi: ${jid}, menunggu nama...`);
    } else {
      console.log(`(User belum terdaftar, bukan keyword aktivasi, diabaikan: "${text}")`);
    }
    return; // user belum terdaftar, flow lain (konfirmasi ngaji dll) belum berlaku
  }

  const state = getUserState(jid);

  if (state === 'WAITING_NAME') {
    // Pakai teks asli (sebelum di-lowercase) biar nama ke-capture rapi.
    // text di sini udah lowercase dari caller, jadi kita capitalize kata pertama tiap kata.
    const namaRapi = text
      .split(' ')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    setUserName(jid, namaRapi);
    setUserState(jid, 'WAITING_LOCATION');
    await sock.sendMessage(jid, { text: PESAN_TANYA_LOKASI_TEMPLATE(namaRapi) });
    console.log(`✅ Nama tersimpan untuk ${jid}: ${namaRapi}, menunggu lokasi...`);
  } else if (state === 'WAITING_LOCATION') {
    const lokasiRapi = text
      .split(' ')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    setUserLocation(jid, lokasiRapi);
    setUserState(jid, 'IDLE');
    const nama = getUserName(jid) || 'Sahabat Dawam';
    await sock.sendMessage(jid, { text: PESAN_ONBOARDING_SELESAI_TEMPLATE(nama, lokasiRapi) });
    await sock.sendMessage(jid, { text: PESAN_PERKENALAN_PERAN });
    console.log(`✅ Lokasi tersimpan untuk ${jid}: ${lokasiRapi}. Onboarding selesai.`);
  } else if (state === 'WAITING_CONFIRM') {
    const nama = getUserName(jid) || 'Sahabat Dawam';

    // Dulu: pencocokan keyword persis. Sekarang: parsing intent via Groq,
    // supaya jawaban bebas ("boleh deh", "nanti aja ya", dll) tetap kebaca.
    const intent = await groqAI.parseIntentJawaban(text);
    console.log(`(Intent terbaca: ${intent})`);

    if (intent === 'YA') {
      const responYa = await groqAI.generateResponYa(nama);
      if (responYa) await sock.sendMessage(jid, { text: responYa });

      await kirimBacaan(jid);
      setUserState(jid, 'IDLE');
    } else if (intent === 'TIDAK') {
      let pesan = await groqAI.generateResponTidak(nama);
      if (!pesan) pesan = PESAN_SETELAH_TIDAK;

      await sock.sendMessage(jid, { text: pesan });
      setUserState(jid, 'IDLE');
    } else {
      // TIDAK_JELAS -> tetap hidupin percakapan, state tetap WAITING_CONFIRM
      let pesan = await groqAI.generateFallbackChat(nama, text);
      if (!pesan) pesan = PESAN_TIDAK_DIMENGERTI;

      await sock.sendMessage(jid, { text: pesan });
    }
  } else {
    // Pesan di luar flow aktif (state IDLE dll) -> tetap dibales natural via Groq,
    // biar percakapan kerasa hidup, bukan diabaikan begitu saja.
    const nama = getUserName(jid) || 'Sahabat Dawam';
    console.log(`(Pesan di luar flow aktif, dibales via Groq fallback)`);
    const pesan = await groqAI.generateFallbackChat(nama, text);
    if (pesan) {
      await sock.sendMessage(jid, { text: pesan });
    } else {
      console.log('(Groq gagal, tidak ada fallback template, pesan diabaikan)');
    }
  }
}

// ========== FUNGSI-FUNGSI TRIGGER ==========

async function kirimReminderSholat(waktuSholat, jid) {
  if (!PESAN_REMINDER_SHOLAT[waktuSholat]) {
    console.log(`⚠️  Waktu sholat "${waktuSholat}" tidak dikenali.`);
    return;
  }

  getOrCreateUser(jid);
  const nama = getUserName(jid) || 'Sahabat Dawam';

  // Coba generate pesan dinamis via Groq, fallback ke template statis kalau gagal
  let pesan = await groqAI.generateReminderSholat(waktuSholat, nama);
  if (!pesan) {
    console.log('⚠️  Groq gagal/kosong, pakai template statis sebagai fallback.');
    pesan = PESAN_REMINDER_SHOLAT[waktuSholat];
  }

  await sock.sendMessage(jid, { text: pesan });
  console.log(`✅ Reminder ${waktuSholat} terkirim ke ${jid}`);

  console.log(`⏳ Menjadwalkan tawaran ngaji dalam ${JEDA_TAWARAN_MS / 1000} detik...`);
  setTimeout(() => kirimTawaranNgaji(jid), JEDA_TAWARAN_MS);
}

async function kirimTawaranNgaji(jid) {
  const nama = getUserName(jid) || 'Sahabat Dawam';

  let pesan = await groqAI.generateTawaranNgaji(nama);
  if (!pesan) {
    console.log('⚠️  Groq gagal/kosong, pakai template statis sebagai fallback.');
    pesan = PESAN_TAWARAN_NGAJI_TEMPLATE(nama);
  }

  await sock.sendMessage(jid, { text: pesan });
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

let schedulerSudahDiset = false;

function setupScheduler() {
  if (schedulerSudahDiset) {
    console.log('(Scheduler sudah pernah diset sebelumnya, dilewati biar ga dobel)');
    return;
  }
  schedulerSudahDiset = true;

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