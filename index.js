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
  getUser,
  setUserState,
  getUserState,
  getAllUsers,
  getOrCreateUser,
  isUserRegistered,
  registerUser,
  setUserName,
  setUserLocation,
  getUserName,
  // phase 2
  getBacaanById,
  cariBacaanBySuratLike,
  setUserGender,
  setUserTarget,
  setUserMotivasi,
  setUserMulaiSurat,
  updateLastSentBacaanId,
  setTanggalMulaiBaca,
  incrementNoResponse,
  resetNoResponse,
  setModeArabSaja,
  setWaktuTawaranTerakhir,
} = require('./db');
const groqAI = require('./groq');
const { buatToolExecutors } = require('./tools');

// ========== KONFIGURASI ==========

const JEDA_TAWARAN_MS = 1 * 60 * 1000; // 1 menit (prototype)
const AMBANG_SILENT_JAM = 6; // silent user dianggap no-response setelah 6 jam (§7.3)
const INTERVAL_CRON_SILENT = '0 */3 * * *'; // tiap 3 jam

const JADWAL_SHOLAT = {
  subuh: { jam: 4, menit: 20 },
  dzuhur: { jam: 11, menit: 44 },
  ashar: { jam: 14, menit: 47 },
  maghrib: { jam: 17, menit: 49 },
  isya: { jam: 18, menit: 55 },
};

function getRegisteredTargets() {
  return getAllUsers()
    .filter((u) => u.is_registered === 1)
    .map((u) => u.jid);
}

// ========== PESAN STATIS (fallback kalau Groq gagal) ==========

const PESAN_REMINDER_SHOLAT = {
  subuh: 'Assalamu\'alaikum 🌙\nWaktu Subuh telah tiba. Yuk, mulai hari dengan sujud pertama kita kepada Allah ﷻ.\n\n"Dan dirikanlah shalat, sesungguhnya shalat itu mencegah dari (perbuatan-perbuatan) keji dan mungkar." (QS. Al-Ankabut: 45)',
  dzuhur: 'Assalamu\'alaikum ☀️\nWaktu Dzuhur telah tiba. Mari sejenak rehat dari aktivitas untuk menghadap Allah ﷻ.',
  ashar: 'Assalamu\'alaikum 🌤️\nWaktu Ashar telah tiba. Jangan sampai terlewat, Sahabat Dawam.',
  maghrib: 'Assalamu\'alaikum 🌆\nWaktu Maghrib telah tiba. Saatnya berhenti sejenak dan kembali mengingat-Nya.',
  isya: 'Assalamu\'alaikum 🌃\nWaktu Isya telah tiba. Tutup hari ini dengan shalat dan doa terbaik.',
};

const PESAN_TAWARAN_NGAJI_TEMPLATE = (nama) =>
  `Semoga shalatnya diterima Allah ﷻ 🤲\n\n${nama}, sudah siap lanjut tilawah hari ini? Yuk sisihkan sedikit waktu untuk membaca Al-Qur'an 📖\n\nBalas *"ya"* untuk lanjut membaca, atau *"nanti"* kalau belum sempat.`;

const PESAN_TAWARAN_TERJEMAH_TEMPLATE =
  'Mau lanjut baca artinya juga? Balas *"ya"* atau *"nanti"* ya 😊';

const PESAN_SETELAH_YA_ARAB_TEMPLATE = (suratAyat) =>
  `Barakallahu fiik, semoga menjadi pemberat timbangan kebaikan 🤍\n\nIni bacaan untukmu (${suratAyat}):`;

const PESAN_SETELAH_YA_TERJEMAH_TEMPLATE = (suratAyat) =>
  `Ini artinya (${suratAyat}):`;

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

const PESAN_TANYA_GENDER =
  'Boleh tau, Dawam ngobrol sama Akhi atau Ukhti nih? 😊';

const PESAN_TANYA_GENDER_ULANG =
  'Maaf, Dawam belum nangkep jawabannya 🙏 Akhi (laki-laki) atau Ukhti (perempuan) ya?';

const PESAN_TANYA_TARGET =
  'Mau targetin khatam 1 juz berapa hari? Pilih salah satu ya:\n6 hari (santai, sesuai peta bawaan), 3 hari (sedang), atau 1 hari (cepat).';

const PESAN_TANYA_TARGET_ULANG =
  'Maaf, boleh dijawab salah satu dari: *6 hari*, *3 hari*, atau *1 hari*? 🙏';

const PESAN_TANYA_MOTIVASI =
  'Satu hal lagi. Kalau suatu saat kamu lagi males/berat buat baca Qur\'an, apa yang biasanya bisa bikin kamu semangat lagi? Boleh cerita singkat 😊';

const PESAN_TANYA_MULAI_SURAT =
  'Terakhir, kamu mau mulai tilawah dari surat/ayat apa? Kalau mau mulai dari awal (Al-Fatihah), balas aja *"dari awal"*.';

const PESAN_ONBOARDING_SELESAI_TEMPLATE = (nama, lokasi, target) =>
  `Siap, ${nama}! Dawam sudah catat domisilimu di ${lokasi}, dengan target khatam 1 juz per ${target} hari 📍`;

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
      setupSilentUserChecker();
      printHelp();
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return;

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

// ========== NORMALISASI JID (existing, tidak berubah) ==========

function normalizeJid(message) {
  const remoteJid = message.key.remoteJid;
  const altJid = message.key.senderPn || message.key.remoteJidAlt || null;

  if (remoteJid && remoteJid.endsWith('@lid') && altJid) {
    return altJid;
  }

  return remoteJid;
}

// Helper: kirim pesan dengan jeda kecil opsional sebelumnya, supaya WhatsApp
// tidak menumpuk beberapa pesan sekaligus (terlihat seperti "patah/nyambung aneh"
// kalau dikirim persis bersamaan tanpa jeda).
function tunggu(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function kirimPesan(jid, text, jedaMsSebelum = 0) {
  if (jedaMsSebelum > 0) await tunggu(jedaMsSebelum);
  return sock.sendMessage(jid, { text });
}

// Helper kecil: rapikan kapitalisasi tiap kata (dipakai di beberapa step onboarding)
function rapikanKapital(text) {
  return text
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ========== HANDLER PESAN MASUK ==========

async function handleIncomingMessage(jid, text) {
  // Cek dulu: apakah user belum terdaftar dan ngirim keyword aktivasi?
  if (!isUserRegistered(jid)) {
    if (text === KEYWORD_AKTIVASI) {
      registerUser(jid);
      setUserState(jid, 'WAITING_NAME');
      await kirimPesan(jid, PESAN_SELAMAT_DATANG);
      await kirimPesan(jid, PESAN_TANYA_NAMA, 1500);
      console.log(`✅ User baru teraktivasi: ${jid}, menunggu nama...`);
    } else {
      console.log(`(User belum terdaftar, bukan keyword aktivasi, diabaikan: "${text}")`);
    }
    return;
  }

  const user = getUser(jid);
  const state = user.state;

    const user = getUser(jid);
  const state = user.state;

  // ---- Intent bebas: cek dulu apakah ini pertanyaan progress/lanjut, ----
  // ---- terlepas dari state apapun yang sedang aktif (kecuali flow sangat spesifik) ----
  const stateSangatSpesifik = ['WAITING_NAME', 'WAITING_LOCATION', 'WAITING_GENDER', 'WAITING_TARGET'];
  if (!stateSangatSpesifik.includes(state) && text.length > 1) {
    const intentBebas = await groqAI.classifyIntentBebas(text);
    console.log(`(Intent bebas: ${intentBebas})`);

    if (intentBebas === 'TANYA_PROGRESS') {
      const nama = getUserName(jid) || 'Sahabat Dawam';
      const executors = buatToolExecutors(jid);
      const jawaban = await groqAI.generateJawabanProgress(nama, text, executors);
      if (jawaban) await sock.sendMessage(jid, { text: jawaban });
      return; // tidak ganggu state yang sedang berjalan
    }

    if (intentBebas === 'MINTA_LANJUT' && state !== 'WAITING_CONFIRM' && state !== 'WAITING_LANJUT_SESI') {
      resetNoResponse(jid);
      await kirimBacaanArab(jid);
      return;
    }
  }

  // ---- §6.3: Pengecekan intent mode halangan, SEBELUM state check biasa ----
  // Hanya berlaku untuk user gender P, dan HANYA jika state saat ini bukan state
  // onboarding yang sangat spesifik (WAITING_NAME dll) -- supaya tidak salah tangkap
  // jawaban nama/lokasi sebagai "aktifkan mode halangan".
  // Semua state yang menunggu jawaban SPESIFIK untuk sebuah pertanyaan aktif harus di-skip
  // dari pengecekan mode halangan -- supaya jawaban user ("ya", "lanjut", nama surat, dst)
  // tidak ditafsir ulang sebagai niat aktifkan/nonaktifkan mode terjemah-saja.
  const stateFlowAktif = [
    'WAITING_NAME',
    'WAITING_LOCATION',
    'WAITING_GENDER',
    'WAITING_TARGET',
    'WAITING_MOTIVASI',
    'WAITING_MULAI_SURAT',
    'WAITING_CONFIRM',
    'WAITING_CONFIRM_TERJEMAH',
    'WAITING_LANJUT_SESI',
    'WAITING_ALASAN_TIDAK_BACA',
  ];
  if (user.gender === 'P' && !stateFlowAktif.includes(state)) {
    const intentHalangan = await groqAI.parseModeHalanganIntent(text);
    console.log(`(Cek intent halangan: ${intentHalangan})`);

    if (intentHalangan === 'AKTIFKAN' && user.mode_baca_arab_saja === 1) {
      setModeArabSaja(jid, false);
      let konfirmasi = await groqAI.generateKonfirmasiModeHalangan(getUserName(jid), true);
      if (!konfirmasi) konfirmasi = 'Baik, mode terjemah-saja sudah aktif untukmu 🤍 Istirahat dulu ya, Sahabat.';
      await sock.sendMessage(jid, { text: konfirmasi });
      return; // skip flow state biasa untuk pesan ini
    }

    if (intentHalangan === 'NONAKTIFKAN' && user.mode_baca_arab_saja === 0) {
      setModeArabSaja(jid, true);
      let konfirmasi = await groqAI.generateKonfirmasiModeHalangan(getUserName(jid), false);
      if (!konfirmasi) konfirmasi = 'Alhamdulillah, mode normal sudah aktif lagi. Yuk lanjut tilawah seperti biasa 🤍';
      await sock.sendMessage(jid, { text: konfirmasi });
      return;
    }
    // TIDAK_RELEVAN -> lanjut ke flow state biasa di bawah
  }

  // ---- Flow state biasa ----
  if (state === 'WAITING_NAME') {
    const namaRapi = rapikanKapital(text);
    setUserName(jid, namaRapi);
    setUserState(jid, 'WAITING_LOCATION');
    await sock.sendMessage(jid, { text: PESAN_TANYA_LOKASI_TEMPLATE(namaRapi) });
    console.log(`✅ Nama tersimpan untuk ${jid}: ${namaRapi}, menunggu lokasi...`);
  } else if (state === 'WAITING_LOCATION') {
    const lokasiRapi = rapikanKapital(text);
    setUserLocation(jid, lokasiRapi);
    setUserState(jid, 'WAITING_GENDER');
    await sock.sendMessage(jid, { text: PESAN_TANYA_GENDER });
    console.log(`✅ Lokasi tersimpan untuk ${jid}: ${lokasiRapi}, menunggu gender...`);
  } else if (state === 'WAITING_GENDER') {
    const gender = await groqAI.parseGenderDariJawaban(text);
    if (gender === 'TIDAK_JELAS') {
      await sock.sendMessage(jid, { text: PESAN_TANYA_GENDER_ULANG });
      return;
    }
    setUserGender(jid, gender);
    setUserState(jid, 'WAITING_TARGET');
    await sock.sendMessage(jid, { text: PESAN_TANYA_TARGET });
    console.log(`✅ Gender tersimpan untuk ${jid}: ${gender}, menunggu target...`);
  } else if (state === 'WAITING_TARGET') {
    const target = await groqAI.parseTargetDariJawaban(text);
    if (target === 'TIDAK_JELAS') {
      await sock.sendMessage(jid, { text: PESAN_TANYA_TARGET_ULANG });
      return;
    }
    setUserTarget(jid, target);
    setUserState(jid, 'WAITING_MOTIVASI');
    await sock.sendMessage(jid, { text: PESAN_TANYA_MOTIVASI });
    console.log(`✅ Target tersimpan untuk ${jid}: ${target} hari/juz, menunggu motivasi...`);
  } else if (state === 'WAITING_MOTIVASI') {
    // Simpan verbatim (teks asli lowercase sudah cukup sebagai catatan personal,
    // tidak perlu dirapikan kapitalisasinya seperti nama/lokasi)
    setUserMotivasi(jid, text);
    setUserState(jid, 'WAITING_MULAI_SURAT');
    await sock.sendMessage(jid, { text: PESAN_TANYA_MULAI_SURAT });
    console.log(`✅ Motivasi tersimpan untuk ${jid}, menunggu titik mulai surat...`);
  } else if (state === 'WAITING_MULAI_SURAT') {
    await handleJawabanMulaiSurat(jid, text);
  } else if (state === 'WAITING_CONFIRM') {
    await handleJawabanTawaranNgaji(jid, text);
  } else if (state === 'WAITING_CONFIRM_TERJEMAH') {
    await handleJawabanTawaranTerjemah(jid, text);
  } else if (state === 'WAITING_LANJUT_SESI') {
    await handleJawabanLanjutSesi(jid, text);
  } else if (state === 'WAITING_ALASAN_TIDAK_BACA') {
    const nama = getUserName(jid) || 'Sahabat Dawam';
    const pesan = await groqAI.generateFallbackChat(nama, text);
    if (pesan) await sock.sendMessage(jid, { text: pesan });
    setUserState(jid, 'IDLE');
  } else {
    // IDLE atau state lain di luar flow aktif -> dibales natural via Groq
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

// ---- Sub-handler: WAITING_MULAI_SURAT (§3.1) ----
async function handleJawabanMulaiSurat(jid, text) {
  const nama = getUserName(jid) || 'Sahabat Dawam';
  const lokasi = (await getUser(jid)).location;
  const target = (await getUser(jid)).target_juz_per_hari;

  const mauDariAwal = ['dari awal', 'awal', 'al-fatihah', 'fatihah'].includes(text.trim());

  if (!mauDariAwal) {
    const { surat } = await groqAI.parseSuratAyatDariJawaban(text);
    setUserMulaiSurat(jid, text); // simpan raw text apapun hasilnya, buat referensi

    if (surat) {
      const bacaanDitemukan = cariBacaanBySuratLike(surat);
      if (bacaanDitemukan) {
        updateLastSentBacaanId(jid, bacaanDitemukan.id - 1); // -1 karena nextId = last_sent + 1
        await sock.sendMessage(jid, {
          text: `Siap, Dawam akan mulai dari sekitar ${bacaanDitemukan.surat_ayat} ya 🤍`,
        });
        await selesaikanOnboarding(jid, nama, lokasi, target);
        return;
      }
    }

    // Tidak ketemu / ambigu -> fallback mulai dari awal, beri tahu user
    await sock.sendMessage(jid, {
      text: 'Hmm, Dawam belum nemu posisi yang pas untuk itu di peta bacaan 🙏 Untuk sekarang kita mulai dari awal dulu ya, nanti bisa disesuaikan lagi.',
    });
  }

  // last_sent_bacaan_id tetap default 0 (mulai dari awal)
  await selesaikanOnboarding(jid, nama, lokasi, target);
}

async function selesaikanOnboarding(jid, nama, lokasi, target) {
  setUserState(jid, 'IDLE');
  await kirimPesan(jid, PESAN_ONBOARDING_SELESAI_TEMPLATE(nama, lokasi, target));
  await kirimPesan(jid, PESAN_PERKENALAN_PERAN, 1500); // jeda 1.5 detik biar ga numpuk
  console.log(`✅ Onboarding selesai untuk ${jid}.`);
}

// ---- Sub-handler: WAITING_CONFIRM (tawaran ngaji awal) ----
async function handleJawabanTawaranNgaji(jid, text) {
  const nama = getUserName(jid) || 'Sahabat Dawam';
  const intent = await groqAI.parseIntentJawaban(text);
  console.log(`(Intent tawaran ngaji: ${intent})`);

  if (intent === 'YA') {
    const responYa = await groqAI.generateResponYa(nama);
    if (responYa) await sock.sendMessage(jid, { text: responYa });

    resetNoResponse(jid); // §7.1: reset counter begitu user benar-benar mau baca
    await tunggu(1500); // jeda kecil biar gambar ga numpuk sama pesan teks sebelumnya
    await kirimBacaanArab(jid);
  } else if (intent === 'TIDAK') {
    incrementNoResponse(jid); // §7.1
    let pesan = await groqAI.generateResponTidak(nama);
    if (!pesan) pesan = PESAN_SETELAH_TIDAK;
    await sock.sendMessage(jid, { text: pesan });
    setUserState(jid, 'IDLE');

    await cekDanKirimPesan3xJikaPerlu(jid);
  } else {
    // TIDAK_JELAS -> tetap hidupin percakapan, state tetap WAITING_CONFIRM
    let pesan = await groqAI.generateFallbackChat(nama, text);
    if (!pesan) pesan = PESAN_TIDAK_DIMENGERTI;
    await sock.sendMessage(jid, { text: pesan });
  }
}

// ---- Sub-handler: WAITING_CONFIRM_TERJEMAH (§5) ----
async function handleJawabanTawaranTerjemah(jid, text) {
  const nama = getUserName(jid) || 'Sahabat Dawam';
  const intent = await groqAI.parseIntentJawaban(text);
  console.log(`(Intent tawaran terjemah: ${intent})`);

  if (intent === 'YA') {
    const user = getUser(jid);
    const bacaan = getBacaanById(user.last_sent_bacaan_id); // row yang SAMA, belum berubah
    if (bacaan) {
      try {
        await sock.sendMessage(jid, {
          image: { url: path.join(__dirname, bacaan.path_indo) },
          caption: PESAN_SETELAH_YA_TERJEMAH_TEMPLATE(bacaan.surat_ayat),
        });
        console.log(`✅ Terjemah terkirim ke ${jid}: ${bacaan.surat_ayat}`);
      } catch (err) {
        console.error('❌ Gagal kirim terjemah:', err.message);
      }
    }
    await cekKecepatanDanTawarkanLanjut(jid);
  } else if (intent === 'TIDAK') {
    await cekKecepatanDanTawarkanLanjut(jid);
  } else {
    let pesan = await groqAI.generateFallbackChat(nama, text);
    if (!pesan) pesan = PESAN_TIDAK_DIMENGERTI;
    await sock.sendMessage(jid, { text: pesan });
    // state tetap WAITING_CONFIRM_TERJEMAH
  }
}

// ---- Sub-handler: WAITING_LANJUT_SESI (§4.3) ----
async function handleJawabanLanjutSesi(jid, text) {
  const nama = getUserName(jid) || 'Sahabat Dawam';
  const intent = await groqAI.parseIntentJawaban(text);
  console.log(`(Intent lanjut sesi: ${intent})`);

  if (intent === 'YA') {
    await kirimBacaanArab(jid); // lanjut kartu berikutnya, sesi sama
  } else if (intent === 'TIDAK') {
    const user = getUser(jid);
    let pesan = await groqAI.generateIngatkanTargetAsli(nama, user.target_juz_per_hari);
    if (pesan) await sock.sendMessage(jid, { text: pesan });
    setUserState(jid, 'IDLE');
  } else {
    let pesan = await groqAI.generateFallbackChat(nama, text);
    if (!pesan) pesan = PESAN_TIDAK_DIMENGERTI;
    await sock.sendMessage(jid, { text: pesan });
    // state tetap WAITING_LANJUT_SESI
  }
}

// ========== LOGIC PENGIRIMAN BACAAN (§4) ==========

async function kirimBacaanArab(jid) {
  const user = getUser(jid);

  if (user.mode_baca_arab_saja === 0) {
    return kirimBacaanTerjemahSaja(jid);
  }

  let nextId = user.last_sent_bacaan_id + 1;
  if (nextId > 900) {
    nextId = 1; // TEMPORARY: looping balik ke awal
  }

  const bacaan = getBacaanById(nextId);
  if (!bacaan) {
    await sock.sendMessage(jid, { text: 'Maaf, data bacaan belum tersedia saat ini 🙏' });
    console.log(`⚠️  Bacaan id=${nextId} tidak ditemukan di database (seed belum lengkap?).`);
    return;
  }

  try {
    await sock.sendMessage(jid, {
      image: { url: path.join(__dirname, bacaan.path_arab) },
      caption: PESAN_SETELAH_YA_ARAB_TEMPLATE(bacaan.surat_ayat),
    });
  } catch (err) {
    console.error('❌ Gagal kirim bacaan Arab:', err.message);
    return;
  }

  if (!user.tanggal_mulai_baca) {
    setTanggalMulaiBaca(jid, new Date().toISOString().slice(0, 10)); // hanya terisi sekali
  }

  updateLastSentBacaanId(jid, nextId);
  setUserState(jid, 'WAITING_CONFIRM_TERJEMAH');
  console.log(`✅ Bacaan Arab terkirim ke ${jid}: ${bacaan.surat_ayat} (id=${nextId})`);
}

async function kirimBacaanTerjemahSaja(jid) {
  const user = getUser(jid);

  let nextId = user.last_sent_bacaan_id + 1;
  if (nextId > 900) {
    nextId = 1;
  }

  const bacaan = getBacaanById(nextId);
  if (!bacaan) {
    await sock.sendMessage(jid, { text: 'Maaf, data bacaan belum tersedia saat ini 🙏' });
    console.log(`⚠️  Bacaan id=${nextId} tidak ditemukan (mode terjemah-saja).`);
    return;
  }

  try {
    await sock.sendMessage(jid, {
      image: { url: path.join(__dirname, bacaan.path_indo) },
      caption: PESAN_SETELAH_YA_TERJEMAH_TEMPLATE(bacaan.surat_ayat),
    });
  } catch (err) {
    console.error('❌ Gagal kirim bacaan terjemah-saja:', err.message);
    return;
  }

  if (!user.tanggal_mulai_baca) {
    setTanggalMulaiBaca(jid, new Date().toISOString().slice(0, 10));
  }

  updateLastSentBacaanId(jid, nextId);
  console.log(`✅ Terjemah-saja terkirim ke ${jid}: ${bacaan.surat_ayat} (id=${nextId})`);

  // Mode terjemah-saja: tidak ada tawaran "mau Arab juga", langsung ke pengecekan kecepatan (§6.4)
  await cekKecepatanDanTawarkanLanjut(jid);
}

// ---- §4.3: Deteksi kecepatan & tawaran lanjut ----
async function cekKecepatanDanTawarkanLanjut(jid) {
  const user = getUser(jid);
  const nama = getUserName(jid) || 'Sahabat Dawam';

  // Pace normal (target 6 hari/juz, atau belum pilih target) -> cukup kasih penutup singkat,
  // tidak perlu bahas kecepatan sama sekali.
  if (user.target_juz_per_hari === '6' || !user.target_juz_per_hari) {
    await tutupSesiBaca(jid, nama);
    setUserState(jid, 'IDLE');
    return;
  }

  const bacaanTerakhir = getBacaanById(user.last_sent_bacaan_id);
  if (!bacaanTerakhir || !user.tanggal_mulai_baca) {
    await tutupSesiBaca(jid, nama);
    setUserState(jid, 'IDLE');
    return;
  }

  const hariTercapai = bacaanTerakhir.hari_global;
  const hariBerjalan = hitungSelisihHari(user.tanggal_mulai_baca, new Date()) + 1;

  let hariTarget;
  if (user.target_juz_per_hari === '3') {
    hariTarget = hariBerjalan * 2;
  } else if (user.target_juz_per_hari === '1') {
    hariTarget = hariBerjalan * 6;
  } else {
    await tutupSesiBaca(jid, nama);
    setUserState(jid, 'IDLE');
    return;
  }

  if (hariTercapai < hariTarget) {
    // Masih di bawah pace -> tawarkan lanjut
    let pesan = await groqAI.generateTawaranLanjutSesi(nama, user.target_juz_per_hari);
    if (!pesan) {
      pesan = `Mantap, ${nama}! Mau lanjut baca lagi sekarang biar makin dekat ke target ${user.target_juz_per_hari} hari/juz, atau cukup dulu?`;
    }
    await sock.sendMessage(jid, { text: pesan });
    setUserState(jid, 'WAITING_LANJUT_SESI');
  } else {
    // Pace hari ini sudah tercapai/lampaui -> kasih tahu dengan jelas, jangan diam-diam IDLE
    let pesan = await groqAI.generateSudahCapaiPace(nama, user.target_juz_per_hari);
    if (!pesan) {
      pesan = `Alhamdulillah, ${nama} sudah mencapai target hari ini (1 juz per ${user.target_juz_per_hari} hari) 🤍 Sampai jumpa di waktu sholat berikutnya ya!`;
    }
    await sock.sendMessage(jid, { text: pesan });
    setUserState(jid, 'IDLE');
  }
}

// Penutup singkat untuk pace normal (target 6 hari) atau kondisi data belum lengkap,
// supaya user tetap tahu sesi membacanya sudah selesai, bukan diam tanpa kabar.
async function tutupSesiBaca(jid, nama) {
  let pesan = await groqAI.generatePenutupSesiBiasa(nama);
  if (!pesan) {
    pesan = `Barakallahu fiik, ${nama} 🤍 Sampai jumpa lagi di waktu sholat berikutnya.`;
  }
  await sock.sendMessage(jid, { text: pesan });
}

// Selisih hari kalender (dibulatkan ke bawah), dipakai untuk hariBerjalan di §4.3
function hitungSelisihHari(tanggalMulaiISO, tanggalSekarang) {
  const mulai = new Date(tanggalMulaiISO);
  const sekarang = new Date(
    tanggalSekarang.getFullYear(),
    tanggalSekarang.getMonth(),
    tanggalSekarang.getDate()
  );
  const mulaiTengahMalam = new Date(mulai.getFullYear(), mulai.getMonth(), mulai.getDate());
  const selisihMs = sekarang - mulaiTengahMalam;
  return Math.floor(selisihMs / (1000 * 60 * 60 * 24));
}

// ========== §7: COUNTER TIDAK BACA + PESAN MOTIVASI ==========

async function cekDanKirimPesan3xJikaPerlu(jid) {
  const user = getUser(jid);
  if (user.consecutive_no_response >= 3) {
    await kirimPesanSetelah3xTidakBaca(jid);
  }
}

async function kirimPesanSetelah3xTidakBaca(jid) {
  const user = getUser(jid);
  const nama = getUserName(jid) || 'Sahabat Dawam';

  if (user.gender === 'P' && user.mode_baca_arab_saja === 1) {
    let pesanHalangan = await groqAI.generateTawaranModeHalangan(nama);
    if (pesanHalangan) await sock.sendMessage(jid, { text: pesanHalangan });
  }

  let pesan = await groqAI.generatePesanSetelah3xTidakBaca(nama, user.motivasi_personal);
  if (!pesan) {
    pesan = `${nama}, Dawam notice kamu belum sempat tilawah beberapa kali terakhir 🤍 Ga apa-apa, boleh cerita lagi sibuk apa? Semangat terus ya, pelan-pelan juga gapapa.`;
  }
  await sock.sendMessage(jid, { text: pesan });

  setUserState(jid, 'WAITING_ALASAN_TIDAK_BACA');
  resetNoResponse(jid);
  console.log(`✅ Pesan 3x-tidak-baca terkirim ke ${jid}, counter direset.`);
}

// ---- §7.3: Cron pengecekan silent user ----
let silentCheckerSudahDiset = false;

function setupSilentUserChecker() {
  if (silentCheckerSudahDiset) return;
  silentCheckerSudahDiset = true;

  cron.schedule(INTERVAL_CRON_SILENT, async () => {
    console.log('\n🔍 Menjalankan pengecekan silent user...');
    const ambangMs = AMBANG_SILENT_JAM * 60 * 60 * 1000;
    const sekarang = Date.now();

    const silentUsers = getAllUsers().filter((u) => {
      if (u.state !== 'WAITING_CONFIRM') return false;
      if (!u.waktu_tawaran_terakhir) return false;
      const waktuTawaran = new Date(u.waktu_tawaran_terakhir).getTime();
      return sekarang - waktuTawaran > ambangMs;
    });

    for (const u of silentUsers) {
      incrementNoResponse(u.jid);
      setUserState(u.jid, 'IDLE');
      console.log(`⏳ User ${u.jid} dianggap silent, counter naik.`);

      const userTerbaru = getUser(u.jid);
      if (userTerbaru.consecutive_no_response >= 3) {
        await kirimPesanSetelah3xTidakBaca(u.jid);
      }
    }

    if (silentUsers.length === 0) {
      console.log('(Tidak ada silent user saat ini)');
    }
  });

  console.log(`🕒 Silent user checker diset, jalan tiap 3 jam (ambang ${AMBANG_SILENT_JAM} jam diam).`);
}

// ========== FUNGSI-FUNGSI TRIGGER REMINDER ==========

async function kirimReminderSholat(waktuSholat, jid) {
  if (!PESAN_REMINDER_SHOLAT[waktuSholat]) {
    console.log(`⚠️  Waktu sholat "${waktuSholat}" tidak dikenali.`);
    return;
  }

  getOrCreateUser(jid);
  const nama = getUserName(jid) || 'Sahabat Dawam';

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
  const user = getUser(jid);
  const nama = getUserName(jid) || 'Sahabat Dawam';

  // §6.2a: tawarkan mode halangan hanya SEKALI, ke user gender P, saat tawaran pertama kali
  const belumPernahDitawarkanMode = user.gender === 'P' && !user.waktu_tawaran_terakhir;

  let pesan;
  if (belumPernahDitawarkanMode) {
    pesan = await groqAI.generateTawaranNgajiUntukP(nama);
  } else {
    pesan = await groqAI.generateTawaranNgaji(nama);
  }
  if (!pesan) {
    console.log('⚠️  Groq gagal/kosong, pakai template statis sebagai fallback.');
    pesan = PESAN_TAWARAN_NGAJI_TEMPLATE(nama);
  }

  await sock.sendMessage(jid, { text: pesan });
  setUserState(jid, 'WAITING_CONFIRM');
  setWaktuTawaranTerakhir(jid, new Date().toISOString());
  console.log(`✅ Tawaran ngaji terkirim ke ${jid}, menunggu balasan...`);
}

// ========== SCHEDULER OTOMATIS (existing, tidak berubah) ==========

let schedulerSudahDiset = false;

function setupScheduler() {
  if (schedulerSudahDiset) {
    console.log('(Scheduler sudah pernah diset sebelumnya, dilewati biar ga dobel)');
    return;
  }
  schedulerSudahDiset = true;

  for (const [namaWaktu, jadwal] of Object.entries(JADWAL_SHOLAT)) {
    const cronExpr = `${jadwal.menit} ${jadwal.jam} * * *`;

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

// ========== COMMAND MANUAL VIA TERMINAL (existing, tidak berubah) ==========

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