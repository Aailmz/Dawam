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
  getBacaanByUrutan,
  getUrutanMin,
  getUrutanMax,
  pathArabDariKode,
  pathIndoDariKode,
  cariBacaanBySuratLike,
  setUserGender,
  setUserTarget,
  setUserMotivasi,
  setUserMulaiSurat,
  updateLastSentBacaanId,
  setTanggalMulaiBaca,
  setStartBacaanId,
  setTanggalTerakhirBaca,
  sudahKhatamSetelahWrap,
  incrementNoResponse,
  resetNoResponse,
  setModeArabSaja,
  setWaktuTawaranTerakhir,
  setGroupSosialUser,
  isUserActive,
  nonaktifkanUser,
  aktifkanKembaliUser,
  // onboarding conversational
  getFieldOnboardingKosong,
  updateUserFields,
  // phase 3 - groups (sosial)
  getOrCreateGroup,
  getGroup,
  isGroupAktif,
  aktifkanGroup,
  setGroupState,
  setGroupWaktuMotivasiTerakhir,
  getAllGroupsAktif,
  tambahAnggotaGroup,
  hapusAnggotaGroup,
  getAnggotaGroup,
  catatAktivitasGroup,
  getRekapProgressGroup,
  // chat history (untuk agent)
  simpanChatHistory,
  getChatHistory,
  setSudahLaporSesiIni,
  setGroupSosialJikaBelumAda,
  hitungSisaProgressUser,
  cariGroupUntukUserDariRoster,
  // log bacaan harian + lelang + rekap mingguan
  catatLogBacaanHarian,
  getLogBacaanHarianRange,
  getAnggotaDiBawahPaceHariIni,
  // Jumat Al-Kahfi
  updateLastSentAlkahfiId,
  setTanggalTerakhirAlkahfi,
  OPSI_TARGET_VALID,
} = require('./db');
const groqAI = require('./groq');
const {
  TOOLS_PERSONAL,
  TOOLS_GRUP,
  EKSEKUTOR_PERSONAL,
  EKSEKUTOR_GRUP,
} = require('./tools');
const { jalankanAgentDawam } = require('./agent');
const { buatPromptPersonal, buatPromptGrup } = require('./prompts');

// ========== KONFIGURASI ==========

const JEDA_TAWARAN_MS = 10 * 60 * 1000; // 1 menit (prototype)
const AMBANG_SILENT_JAM = 6; // silent user dianggap no-response setelah 6 jam (§7.3)
const INTERVAL_CRON_SILENT = '0 */3 * * *'; // tiap 3 jam
const INTERVAL_CRON_MOTIVASI_GROUP = '0 16 * * 5'; // tiap Jumat jam 16:00, rekap MINGGUAN ke grup aktif (bukan ajakan kosong lagi)
const INTERVAL_CRON_REKAP_HARIAN = '0 20 * * *'; // tiap hari jam 20:00, rekap progress ke grup aktif
const INTERVAL_CRON_LELANG_ISYA = '0 19 * * *'; // tiap hari jam 19:00 (bareng jadwal Isya), tawaran lelang card ke grup
const INTERVAL_CRON_ALKAHFI_JUMAT = '0 5 * * 5'; // tiap Jumat jam 5 pagi, tawaran mulai cicilan Al-Kahfi

const JADWAL_SHOLAT = {
  subuh: { jam: 4, menit: 5 },
  dzuhur: { jam: 11, menit: 40 },
  ashar: { jam: 14, menit: 58 },
  maghrib: { jam: 17, menit: 50 },
  isya: { jam: 19, menit: 0 },
};

let BOT_PN_NORMALIZED = null;  // nomor HP bot (format lama, @s.whatsapp.net)
let BOT_LID_NORMALIZED = null; // LID bot (format baru, @lid) -- dipakai di mentionedJid grup


// Tawaran lelang card yang lagi aktif per grup, direset tiap hari.
// Struktur: { [groupJid]: { [userJid]: { nama, jid, diklaimOleh: null|jid } } }
// In-memory saja (prototype) -- kalau bot restart, tawaran hari itu hilang, gak masalah
// karena besok di-generate ulang dari getAnggotaDiBawahPaceHariIni.
const tawaranLelangAktif = {};

function setTawaranLelangGrup(groupJid, daftarDiBawahPace) {
  tawaranLelangAktif[groupJid] = {};
  for (const d of daftarDiBawahPace) {
    tawaranLelangAktif[groupJid][d.jid] = { nama: d.nama, jid: d.jid, diklaimOleh: null };
  }
}

function ambilTawaranLelangAktif(groupJid, namaTarget) {
  const tawaranGrup = tawaranLelangAktif[groupJid];
  if (!tawaranGrup) return null;
  const namaLower = namaTarget.trim().toLowerCase();
  const match = Object.values(tawaranGrup).find(
    (t) => t.diklaimOleh === null && t.nama.toLowerCase().includes(namaLower)
  );
  return match || null;
}

function tandaiTawaranSudahDiklaim(groupJid, userJid) {
  if (tawaranLelangAktif[groupJid]?.[userJid]) {
    tawaranLelangAktif[groupJid][userJid].diklaimOleh = true;
  }
}

function getRegisteredTargets() {
  return getAllUsers()
    .filter((u) => u.is_registered === 1 && u.is_active === 1)
    .map((u) => u.jid);
}

// ========== PESAN STATIS (fallback kalau AI gagal) ==========

const PESAN_REMINDER_SHOLAT = {
  subuh: 'Assalamu\'alaikum 🌙\nWaktu Subuh telah tiba. Yuk, mulai hari dengan sujud pertama kita kepada Allah ﷻ.\n\n"Dan dirikanlah shalat, sesungguhnya shalat itu mencegah dari (perbuatan-perbuatan) keji dan mungkar." (QS. Al-Ankabut: 45)',
  dzuhur: 'Assalamu\'alaikum ☀️\nWaktu Dzuhur telah tiba. Mari sejenak rehat dari aktivitas untuk menghadap Allah ﷻ.',
  ashar: 'Assalamu\'alaikum 🌤️\nWaktu Ashar telah tiba. Jangan sampai terlewat, Sahabat Dawam.',
  maghrib: 'Assalamu\'alaikum 🌆\nWaktu Maghrib telah tiba. Saatnya berhenti sejenak dan kembali mengingat-Nya.',
  isya: 'Assalamu\'alaikum 🌃\nWaktu Isya telah tiba. Tutup hari ini dengan shalat dan doa terbaik.',
};

const TEMPLATE_AUTO_REPORT = [
  (nama, suratAyat) => `${nama} baru aja lanjut baca, sekarang nyampe ${suratAyat} 🤍`,
  (nama, suratAyat) => `Gaskeun, ${nama} udah nyampe ${suratAyat} nih tilawahnya 📖`,
  (nama, suratAyat) => `${nama} abis ngaji, posisi sekarang di ${suratAyat} ✨`,
  (nama, suratAyat) => `Semangat terus, ${nama} baru aja baca sampe ${suratAyat} 🙌`,
];

function buatPesanAutoReport(nama, suratAyat) {
  const pilih = TEMPLATE_AUTO_REPORT[Math.floor(Math.random() * TEMPLATE_AUTO_REPORT.length)];
  return pilih(nama, suratAyat);
}

const PESAN_TAWARAN_NGAJI_TEMPLATE = (nama) =>
  `Semoga shalatnya diterima Allah ﷻ 🤲\n\n${nama}, sudah siap lanjut tilawah hari ini? Yuk sisihkan sedikit waktu untuk membaca Al-Qur'an 📖\n\nBalas *"ya"* untuk lanjut membaca, atau *"nanti"* kalau belum sempat.`;

const PESAN_SETELAH_YA_ARAB_TEMPLATE = (suratAyat) =>
  `Barakallahu fiik, semoga menjadi pemberat timbangan kebaikan 🤍\n\nIni bacaan untukmu (${suratAyat}):`;

const PESAN_SETELAH_YA_TERJEMAH_TEMPLATE = (suratAyat) =>
  `Ini artinya (${suratAyat}):`;

const PESAN_SETELAH_TIDAK =
  'Tidak apa-apa, Sahabat 🤍 Semoga ada waktu lain untuk kembali dekat dengan Al-Qur\'an hari ini.\n\n"Sebaik-baik amalan adalah yang dilakukan secara rutin meskipun sedikit." (HR. Bukhari & Muslim)\n\nDawam akan selalu ada menemanimu, kapan pun kamu siap 🌙';

const PESAN_TIDAK_DIMENGERTI =
  'Maaf, Dawam belum paham maksudnya 🙏 Balas dengan *"ya"* atau *"nanti"* ya, Sahabat.';

const PESAN_SELAMAT_DATANG =
  'Assalamu\'alaikum warahmatullahi wabarakatuh 🌙\n\nSelamat datang di *Dawam*, teman harianmu untuk istiqomah shalat dan tilawah Al-Qur\'an.\n\nMulai sekarang, Dawam akan mengingatkanmu di setiap waktu shalat dan menemanimu tilawah sedikit demi sedikit, tanpa beban.\n\n"Sebaik-baik amalan di sisi Allah adalah yang dikerjakan secara terus-menerus (dawam), walaupun sedikit." (HR. Bukhari & Muslim)\n\nBarakallahu fiik, Sahabat Dawam 🤍';

const PESAN_PEMBUKA_ONBOARDING =
  'Sebelum lanjut, kenalan dulu yuk 😊 Nama panggilannya siapa, dan domisili di mana?';

// Template fallback per-field (dipakai HANYA kalau AI gagal total)
const PESAN_TANYA_NAMA = 'Boleh kasih tahu Dawam, siapa nama panggilanmu? 😊';
const PESAN_TANYA_LOKASI_TEMPLATE = (nama) =>
  `Senang berkenalan denganmu, ${nama} 🤍 Kamu domisili di kota/daerah mana?`;
const PESAN_TANYA_GENDER = 'Boleh tau, Dawam ngobrol sama Akhi atau Ukhti nih? 😊';
const PESAN_TANYA_TARGET =
  'Mau atur tempo baca Qur\'an-nya gimana? Ini maksudnya "butuh berapa hari buat nyelesain 1 juz". Pilih salah satu (boleh jawab angka atau tulisannya):\n1. 1 juz per 6 hari (santai)\n2. 1 juz per 3 hari (sedang)\n3. 1 juz per 1 hari (cepat)';
const PESAN_TANYA_MOTIVASI =
  'Kalau suatu saat kamu lagi males/berat buat baca Qur\'an, apa yang biasanya bisa bikin kamu semangat lagi? 😊';

const PESAN_ONBOARDING_SELESAI_TEMPLATE = (nama, lokasi, target) =>
  `Siap, ${nama}! Dawam sudah catat domisilimu di ${lokasi}, dengan target khatam 1 juz per ${target} hari 📍`;

const PESAN_PERKENALAN_PERAN =
  'Sedikit cerita soal Dawam ya 🤍\n\nSetiap hari, aku bakal ingetin kamu pas waktu shalat tiba. Nggak lama-lama, cuma pengingat sederhana biar nggak kelewat.\n\nSelepas itu, aku juga bakal nanya apakah kamu mau lanjut tilawah sedikit. Nggak ada paksaan, kalau lagi sibuk atau belum sempat, bilang aja "nanti", aku nggak akan maksa 😊\n\nKalau kamu bilang mau, aku kirimin bacaan lanjutannya, dari halaman terakhir yang udah kamu baca. Pelan-pelan aja, yang penting konsisten.\n\nOh iya, kamu juga bisa nanya aku kapan aja kok. Soal progress bacaanmu, mau lanjut baca, atau sekadar cerita. Yuk kita mulai perjalanan ini bareng-bareng, semoga Allah mudahkan 🌙';

const KEYWORD_AKTIVASI = 'dawam';

// Pesan fallback statis kalau AI gagal total untuk fitur grup (jarang kepakai)
const PESAN_GROUP_SETUP_FALLBACK =
  'Assalamu\'alaikum 🌙 Dawam aktif di grup ini sebagai teman cerita progress tilawah dan saling menyemangati.\n\nBacaan Al-Qur\'an tetap dikirim personal ke chat pribadi masing-masing ya, biar nggak spam grup. Mau ngobrol sama Dawam di sini? Tinggal tag/mention atau reply pesan Dawam 😊';

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
      BOT_PN_NORMALIZED = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      BOT_LID_NORMALIZED = sock.user?.lid?.split(':')[0]?.split('@')[0] || null;
      console.log(`🤖 BOT_PN_NORMALIZED: "${BOT_PN_NORMALIZED}", BOT_LID_NORMALIZED: "${BOT_LID_NORMALIZED}"`);

      // WAJIB: supaya Baileys "kenal" semua grup yang sudah pernah di-invite SEBELUM
      // listener ini aktif. Tanpa ini, group-participants.update bisa silently tidak
      // ter-emit untuk grup yang belum pernah di-fetch metadatanya di sesi socket ini.
      sock.groupFetchAllParticipating()
        .then((grups) => {
          console.log(`✅ groupFetchAllParticipating selesai, ${Object.keys(grups).length} grup dikenal.`);
        })
        .catch((err) => {
          console.error('❌ Gagal groupFetchAllParticipating:', err.message);
        });

      setupScheduler();
      setupSilentUserChecker();
      setupGroupMotivasiScheduler();
      //setupRekapHarianScheduler();
      setupLelangIsyaScheduler();
      setupAlkahfiJumatScheduler();
      setupReminderJumatLakiScheduler();
      printHelp();
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    console.log('🔥 event grup masuk:', JSON.stringify(update));

    const { id: groupJid, participants, action } = update;

    const group = getGroup(groupJid);
    if (!group || group.is_aktif === 0) {
      console.log(`(Grup ${groupJid} belum aktif, perubahan member diabaikan.)`);
      return;
    }

    if (action === 'add') {
      const jidBaruList = [];
      for (const participant of participants) {
        const rawJid = participant.id; // ambil string JID dari object
        if (apakahJidBot(rawJid)) continue;

        // phoneNumber sudah tersedia langsung di payload event (format @s.whatsapp.net),
        // jadi tidak perlu lagi resolve lewat groupMetadata.
        const jidTernormalisasi =
          participant.phoneNumber && participant.phoneNumber.endsWith('@s.whatsapp.net')
            ? participant.phoneNumber
            : await resolveSenderJidViaGroupMetadata(groupJid, rawJid);

        tambahAnggotaGroup(groupJid, jidTernormalisasi);
        jidBaruList.push(jidTernormalisasi);
        console.log(`✅ Member baru terdeteksi join grup ${groupJid}: ${jidTernormalisasi}`);
      }

      if (jidBaruList.length > 0) {
        const tagText = jidBaruList.map((jid) => `@${jid.split('@')[0]}`).join(' ');
        const teks = `Halo ${tagText}, selamat datang di grup ini 🤍\n\nKalau mau ikutan lapor progress tilawah dan ditemani harian secara personal, tinggal kirim kata *"dawam"* ke chat pribadi Dawam ya 😊`;
        try {
          await sock.sendMessage(groupJid, { text: teks, mentions: jidBaruList });
        } catch (err) {
          console.error('❌ Gagal kirim sapaan member baru:', err.message);
        }
      }
    } else if (action === 'remove') {
      for (const participant of participants) {
        const rawJid = participant.id; // sama, pastikan ambil .id
        if (apakahJidBot(rawJid)) continue;
        const jidTernormalisasi =
          participant.phoneNumber && participant.phoneNumber.endsWith('@s.whatsapp.net')
            ? participant.phoneNumber
            : await resolveSenderJidViaGroupMetadata(groupJid, rawJid);
        hapusAnggotaGroup(groupJid, jidTernormalisasi);
        console.log(`➖ Member keluar dari grup ${groupJid}: ${jidTernormalisasi}`);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return;

    const remoteJid = message.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');

    const text = (
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      ''
    )
      .trim()
      .toLowerCase();

    if (isGroup) {
      // Prioritaskan senderPn (biasanya sudah @s.whatsapp.net) supaya konsisten
      // dengan JID yang dipakai di roster (normalizeParticipantJid) dan di chat personal.
      const sender = message.key.senderPn || message.key.participant;
      if (!sender) return; // tidak bisa identifikasi pengirim, abaikan
      console.log(`\n📩 [GRUP ${remoteJid}] Pesan dari ${sender}: "${text}"`);
      await handleIncomingGroupMessage(remoteJid, sender, text, message);
    } else {
      const sender = normalizeJid(message);
      const textAsli = (
        message.message.conversation ||
        message.message.extendedTextMessage?.text ||
        ''
      ).trim();
      console.log(`\n📩 Pesan masuk dari ${sender}: "${textAsli}"`);
      await handleIncomingMessage(sender, textAsli, text);
    }
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

// Normalisasi JID mentah (dari groupMetadata, bukan dari objek message) ke bentuk
// kanonik @s.whatsapp.net kalau memungkinkan. Baileys kadang kasih participant.id
// dalam bentuk @lid; participant.jid (kalau ada) biasanya versi @s.whatsapp.net-nya.
// Fallback: pakai apa adanya kalau tidak ada pasangannya, supaya tidak hilang dari roster.
function normalizeParticipantJid(participant) {
  if (participant.phoneNumber && participant.phoneNumber.endsWith('@s.whatsapp.net')) {
    return participant.phoneNumber;
  }
  if (participant.id && participant.id.endsWith('@s.whatsapp.net')) {
    return participant.id;
  }
  console.log(`⚠️  Participant ${participant.id} tidak punya pasangan @s.whatsapp.net, disimpan apa adanya.`);
  return participant.id;
}

// Resolve 1 JID (biasanya dari sender pesan masuk, bisa @lid) ke bentuk
// @s.whatsapp.net dengan cari di groupMetadata grup terkait -- reuse field
// phoneNumber yang sudah terbukti ada di situ (lihat normalizeParticipantJid).
async function resolveSenderJidViaGroupMetadata(groupJid, senderJid) {
  if (!senderJid.endsWith('@lid')) return senderJid; // sudah bentuk normal, tidak perlu resolve

  try {
    const metadata = await sock.groupMetadata(groupJid);
    const match = (metadata.participants || []).find((p) => p.id === senderJid);
    if (match?.phoneNumber && match.phoneNumber.endsWith('@s.whatsapp.net')) {
      return match.phoneNumber;
    }
  } catch (err) {
    console.error('❌ Gagal resolve senderJid via groupMetadata:', err.message);
  }

  console.log(`⚠️  Tidak bisa resolve ${senderJid} ke @s.whatsapp.net lewat groupMetadata, dipakai apa adanya.`);
  return senderJid;
}

// Kalau senderJid berupa @lid tapi versi @s.whatsapp.net-nya SUDAH ada di users
// (match by nomor telepon yang sama persis setelah @lid di-resolve lewat sock),
// pakai versi @s.whatsapp.net itu. Baileys biasanya expose pasangan ini lewat
// sock.signalRepository atau message.key.senderPn saat pesan masuk -- tapi di titik
// ini kita cuma punya senderJid mentah, jadi pendekatan paling aman: cek apakah JID
// ini sudah match seseorang yang terdaftar via LID-mapping bawaan Baileys.
function normalisasiSenderUntukGrup(senderJid) {
  if (!senderJid.endsWith('@lid')) return senderJid; // sudah bentuk normal
  try {
    const mapped = sock.signalRepository?.lidMapping?.getPNForLID?.(senderJid);
    if (mapped) return mapped;
  } catch (err) {
    console.error('❌ Gagal resolve LID ke PN:', err.message);
  }
  console.log(`⚠️  Tidak bisa resolve ${senderJid} ke @s.whatsapp.net, dipakai apa adanya.`);
  return senderJid;
}

// Cek apakah sebuah JID (format apapun: @s.whatsapp.net, @lid, dengan/tanpa :device)
// adalah JID milik bot sendiri. Dipakai untuk deteksi mention/reply DAN untuk filter
// bot keluar dari roster grup (supaya bot tidak ikut kehitung sebagai "anggota").
function apakahJidBot(jid) {
  if (!jid) return false;
  const idBersih = jid.split('@')[0].split(':')[0];
  return (
    (BOT_PN_NORMALIZED && idBersih === BOT_PN_NORMALIZED) ||
    (BOT_LID_NORMALIZED && idBersih === BOT_LID_NORMALIZED)
  );
}

function apakahBotDitag(message) {
  const contextInfo = message.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo) return false;

  const mentionedJids = contextInfo.mentionedJid || [];
  const replyParticipant = contextInfo.participant || null;

  const diMention = mentionedJids.some(apakahJidBot);
  const diReplyKeBot = apakahJidBot(replyParticipant);

  return diMention || diReplyKeBot;
}

// Helper: kirim pesan dengan jeda kecil opsional sebelumnya.
function tunggu(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function kirimPesan(jid, text, jedaMsSebelum = 0) {
  if (jedaMsSebelum > 0) await tunggu(jedaMsSebelum);
  return sock.sendMessage(jid, { text });
}

// ========== HANDLER PESAN PERSONAL ==========

async function handleIncomingMessage(jid, textAsli, textLower) {
  // Cek dulu: apakah user belum terdaftar dan ngirim keyword aktivasi?
  if (!isUserRegistered(jid)) {
    if (textLower === KEYWORD_AKTIVASI) {
      registerUser(jid);
      setUserState(jid, 'ONBOARDING');

      // Auto-link ke grup sosial kalau user ini sudah dikenal sebagai anggota
      // suatu grup aktif (dari roster Baileys), walau belum pernah chat di grup itu.
      const groupDariRoster = cariGroupUntukUserDariRoster(jid);
      if (groupDariRoster) {
        setGroupSosialJikaBelumAda(jid, groupDariRoster);
        console.log(`✅ ${jid} auto-linked ke grup sosial ${groupDariRoster} (dari roster).`);
      }

      await kirimPesan(jid, PESAN_SELAMAT_DATANG);
      await kirimPesan(jid, PESAN_PEMBUKA_ONBOARDING, 1500);
      console.log(`✅ User baru teraktivasi: ${jid}, mulai onboarding...`);
    } else {
      console.log(`(User belum terdaftar, bukan keyword aktivasi, diabaikan: "${textLower}")`);
    }
    return;
  }

  const user = getUser(jid);
  const state = user.state;

  if (user.is_active === 0) {
    console.log(`(User ${jid} berstatus nonaktif, tetap diteruskan ke agent supaya bisa reaktivasi natural.)`);
  }

  // Re-check auto-link grup sosial tiap chat personal, bukan cuma sekali saat
  // registrasi -- kasus Mirza: onboarding personal duluan SEBELUM grupnya
  // diaktifkan/roster diambil, jadi auto-link awal gagal nemu grup apapun.
  // Ini jaring pengaman supaya begitu grupnya aktif belakangan, link tetap kejadian
  // di kesempatan pertama dia chat personal lagi.
  if (!user.group_sosial_jid) {
    const groupDariRoster = cariGroupUntukUserDariRoster(jid);
    if (groupDariRoster) {
      setGroupSosialJikaBelumAda(jid, groupDariRoster);
      user.group_sosial_jid = groupDariRoster; // sinkronkan variabel lokal biar konsisten dipakai di bawah
      console.log(`✅ ${jid} auto-linked ke grup sosial ${groupDariRoster} (re-check saat chat).`);
    }
  }

    // ONBOARDING tetap state machine terpisah, tidak lewat agent.
  if (state === 'ONBOARDING') {
    await handleOnboardingTurn(jid, textAsli);
    return;
  }

    // Jumat Al-Kahfi: state machine sederhana terpisah dari agent, mirip ONBOARDING.
  if (state === 'WAITING_KONFIRMASI_ALKAHFI') {
    const intent = await groqAI.parseIntentJawaban(textAsli);
    if (intent === 'YA') {
      await kirimCardAlkahfiLanjutan(jid);
    }
    setUserState(jid, 'IDLE');
    return;
  }

  // Fix: state-machine lama lain juga WAJIB dicek di sini sebelum lempar ke agent.
  // Tanpa ini, pesan user yang sedang di state ini bisa "dicuri" agent tools.js
  // (misal kirim_terjemah_bacaan dipanggil ulang padahal user cuma jawab "nanti"),
  // menyebabkan dua jalur logic saling tabrak/dobel proses.
  if (state === 'WAITING_CONFIRM') {
    await handleJawabanTawaranNgaji(jid, textAsli);
    return;
  }
  if (state === 'WAITING_CONFIRM_TERJEMAH') {
    await handleJawabanTawaranTerjemah(jid, textAsli);
    return;
  }
  if (state === 'WAITING_LANJUT_SESI') {
    await handleJawabanLanjutSesi(jid, textAsli);
    return;
  }

  if (!textAsli || textAsli.length < 2) {
    console.log('(Pesan terlalu pendek/kosong, diabaikan)');
    return;
  }

  simpanChatHistory(jid, 'user', textAsli);

  const konteks = {
    jid,
    kirimBacaanLanjutan: () => kirimBacaanLanjutanUntukAgent(jid),
    kirimTerjemahBacaan: () => kirimTerjemahBacaanUntukAgent(jid),
    kirimKeGrup: async (targetGroupJid, text) => {
      try {
        await sock.sendMessage(targetGroupJid, { text });
        return true;
      } catch (err) {
        console.error('❌ Gagal kirim ke grup (broadcast):', err.message);
        return false;
      }
    },
  };

  const hasil = await jalankanAgentDawam({
    systemPrompt: buatPromptPersonal(user),
    tools: TOOLS_PERSONAL,
    historiChat: getChatHistory(jid, 12),
    pesanBaru: textAsli,
    eksekutorTools: EKSEKUTOR_PERSONAL,
    konteks,
  });

  if (hasil.error || !hasil.jawabanFinal) {
    console.log(`⚠️  Agent gagal/kosong untuk ${jid}: ${hasil.error}`);
    await sock.sendMessage(jid, { text: PESAN_TIDAK_DIMENGERTI });
    return;
  }

  await sock.sendMessage(jid, { text: hasil.jawabanFinal });
  simpanChatHistory(jid, 'assistant', hasil.jawabanFinal);
}

// ---- Sub-handler: ONBOARDING conversational ----
async function handleOnboardingTurn(jid, text) {
  const fieldKosongSebelum = getFieldOnboardingKosong(jid);

  const extracted = await groqAI.extractDataOnboarding(text, fieldKosongSebelum);
  updateUserFields(jid, extracted);

  const fieldBaruTerisi = Object.keys(extracted).filter(
    (k) => extracted[k] !== null && extracted[k] !== undefined && fieldKosongSebelum.includes(k)
  );
  const fieldKosongSesudah = getFieldOnboardingKosong(jid);

  if (fieldKosongSesudah.length === 0) {
    const namaFinal = getUserName(jid) || 'Sahabat Dawam';
    const userFinal = getUser(jid);

    if (userFinal.mulai_surat) {
      const mauDariAwal = ['dari awal', 'awal', 'al-fatihah', 'fatihah'].includes(
        userFinal.mulai_surat.trim().toLowerCase()
      );
      if (!mauDariAwal) {
        const { surat } = await groqAI.parseSuratAyatDariJawaban(userFinal.mulai_surat);
        if (surat) {
          const bacaanDitemukan = cariBacaanBySuratLike(surat);
          if (bacaanDitemukan) {
            updateLastSentBacaanId(jid, bacaanDitemukan.id - 1);
            setStartBacaanId(jid, bacaanDitemukan.id - 1); // titik berangkat, buat hitung pace dari sini
            await sock.sendMessage(jid, {
              text: `Siap, Dawam akan mulai dari sekitar ${bacaanDitemukan.surat_ayat} ya 🤍`,
            });
          }
        }
      }
    }

    await selesaikanOnboarding(jid, namaFinal, userFinal.location, userFinal.target_juz_per_hari);
    return;
  }

  const pesan = await groqAI.generateLanjutanOnboarding(
    getUserName(jid),
    fieldBaruTerisi,
    fieldKosongSesudah,
    text
  );

  if (pesan) {
    await sock.sendMessage(jid, { text: pesan });
  } else {
    const fallbackMap = {
      name: PESAN_TANYA_NAMA,
      location: PESAN_TANYA_LOKASI_TEMPLATE(getUserName(jid) || 'Sahabat'),
      gender: PESAN_TANYA_GENDER,
      target_juz_per_hari: PESAN_TANYA_TARGET,
      motivasi_personal: PESAN_TANYA_MOTIVASI,
    };
    await sock.sendMessage(jid, {
      text: fallbackMap[fieldKosongSesudah[0]] || PESAN_TIDAK_DIMENGERTI,
    });
  }

  console.log(
    `(Onboarding ${jid}: field baru terisi=[${fieldBaruTerisi.join(', ')}], masih kosong=[${fieldKosongSesudah.join(', ')}])`
  );
}

async function selesaikanOnboarding(jid, nama, lokasi, target) {
  setUserState(jid, 'IDLE');
  await kirimPesan(jid, PESAN_ONBOARDING_SELESAI_TEMPLATE(nama, lokasi, target));
  await kirimPesan(jid, PESAN_PERKENALAN_PERAN, 1500);

  const user = getUser(jid);
  let pesanCTA = await groqAI.generateCTASetelahOnboarding(nama, user.motivasi_personal, target, lokasi);
    if (!pesanCTA) pesanCTA = `Btw ${nama}, kesibukan sehari-hari kamu lagi ngapain nih?`;

  await kirimPesan(jid, pesanCTA, 1500);
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
    resetNoResponse(jid);
    await tunggu(1500);
    await kirimBacaanArab(jid);
  } else if (intent === 'TIDAK') {
    incrementNoResponse(jid);
    let pesan = await groqAI.generateResponTidak(nama);
    if (!pesan) pesan = PESAN_SETELAH_TIDAK;
    await sock.sendMessage(jid, { text: pesan });
    setUserState(jid, 'IDLE');
    await cekDanKirimPesan3xJikaPerlu(jid);
  } else {
    // TIDAK_JELAS: bukan jawaban ya/nanti. Lepas state WAITING_CONFIRM,
    // lempar ke agent supaya pesan user (misal tanya progress) beneran dijawab
    // pakai tool, bukan cuma fallback chat generik.
    setUserState(jid, 'IDLE');

    simpanChatHistory(jid, 'user', text);
    const user = getUser(jid);
    const konteks = {
      jid,
      kirimBacaanLanjutan: () => kirimBacaanLanjutanUntukAgent(jid),
      kirimTerjemahBacaan: () => kirimTerjemahBacaanUntukAgent(jid),
      kirimKeGrup: async (targetGroupJid, teksKirim) => {
        try {
          await sock.sendMessage(targetGroupJid, { text: teksKirim });
          return true;
        } catch (err) {
          console.error('❌ Gagal kirim ke grup (broadcast):', err.message);
          return false;
        }
      },
    };

    const hasil = await jalankanAgentDawam({
      systemPrompt: buatPromptPersonal(user),
      tools: TOOLS_PERSONAL,
      historiChat: getChatHistory(jid, 12),
      pesanBaru: text,
      eksekutorTools: EKSEKUTOR_PERSONAL,
      konteks,
    });

    if (hasil.error || !hasil.jawabanFinal) {
      await sock.sendMessage(jid, { text: PESAN_TIDAK_DIMENGERTI });
      return;
    }

    await sock.sendMessage(jid, { text: hasil.jawabanFinal });
    simpanChatHistory(jid, 'assistant', hasil.jawabanFinal);
  }
}

// ---- Sub-handler: WAITING_CONFIRM_TERJEMAH (§5) ----
async function handleJawabanTawaranTerjemah(jid, text) {
  const nama = getUserName(jid) || 'Sahabat Dawam';
  const intent = await groqAI.parseIntentJawaban(text);
  console.log(`(Intent tawaran terjemah: ${intent})`);

  if (intent === 'YA') {
    const user = getUser(jid);
    const bacaan = getBacaanByUrutan(user.last_sent_bacaan_id);
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
  }
}

// ---- Sub-handler: WAITING_LANJUT_SESI (§4.3) ----
async function handleJawabanLanjutSesi(jid, text) {
  const nama = getUserName(jid) || 'Sahabat Dawam';
  const intent = await groqAI.parseIntentJawaban(text);
  console.log(`(Intent lanjut sesi: ${intent})`);

  if (intent === 'YA') {
    await kirimBacaanArab(jid);
  } else if (intent === 'TIDAK') {
    const user = getUser(jid);
    const sisa = hitungSisaProgressUser(jid);

    if (sisa.ada_target && (sisa.status === 'SUDAH_CAPAI_PACE' || sisa.status === 'PAS_PACE')) {
      // Sudah capai target, user milih cukup -- ini capaian, bukan kurang, jadi JANGAN
      // pakai generateIngatkanTargetAsli (itu buat yang masih kurang dari target).
      let pesan = await groqAI.generatePenutupSesiBiasa(nama);
      if (!pesan) pesan = `Mantap, ${nama}! Udah 100% target hari ini, istirahat dulu gapapa 🤍 Sampai jumpa di waktu sholat berikutnya.`;
      await sock.sendMessage(jid, { text: pesan });
    } else {
      let pesan = await groqAI.generateIngatkanTargetAsli(nama, user.target_juz_per_hari);
      if (pesan) await sock.sendMessage(jid, { text: pesan });
    }
    setUserState(jid, 'IDLE');
  } else {
    let pesan = await groqAI.generateFallbackChat(nama, text);
    if (!pesan) pesan = PESAN_TIDAK_DIMENGERTI;
    await sock.sendMessage(jid, { text: pesan });
  }
}

// ========== LOGIC PENGIRIMAN BACAAN -- SELALU PERSONAL (§4) ==========
// PENTING: fungsi-fungsi ini HANYA pernah dipanggil dengan jid personal (@s.whatsapp.net),
// TIDAK PERNAH dengan jid grup. Bacaan tidak pernah dikirim ke grup.

async function kirimBacaanArab(jid) {
  const user = getUser(jid);

  if (user.mode_baca_arab_saja === 0) {
    return kirimBacaanTerjemahSaja(jid);
  }

  const urutanMin = getUrutanMin();
  const urutanMax = getUrutanMax();
  const urutanSebelumWrap = (user.last_sent_bacaan_id || 0) + 1;
  let nextUrutan = urutanSebelumWrap;
  if (nextUrutan > urutanMax) {
    nextUrutan = urutanMin;
  }

  const startBacaanId = user.start_bacaan_id || 0;
  if (sudahKhatamSetelahWrap(startBacaanId, urutanSebelumWrap, nextUrutan)) {
    setStartBacaanId(jid, nextUrutan - 1 < urutanMin ? urutanMax : nextUrutan - 1);
  }

  const bacaan = getBacaanByUrutan(nextUrutan);
  if (!bacaan) {
    await sock.sendMessage(jid, { text: 'Maaf, data bacaan belum tersedia saat ini 🙏' });
    console.log(`⚠️  Bacaan urutan=${nextUrutan} tidak ditemukan di database (seed belum lengkap?).`);
    return;
  }

  try {
    await sock.sendMessage(jid, {
      image: { url: path.join(__dirname, pathArabDariKode(bacaan.kode)) },
      caption: PESAN_SETELAH_YA_ARAB_TEMPLATE(bacaan.surat_ayat),
    });
  } catch (err) {
    console.error('❌ Gagal kirim bacaan Arab:', err.message);
    return;
  }

  if (!user.tanggal_mulai_baca) {
    setTanggalMulaiBaca(jid, new Date().toISOString().slice(0, 10));
  }

  updateLastSentBacaanId(jid, nextUrutan);
  setTanggalTerakhirBaca(jid, new Date().toISOString().slice(0, 10));
  catatLogBacaanHarian(jid, new Date().toISOString().slice(0, 10), nextUrutan, bacaan.surat_ayat, null);
  setUserState(jid, 'WAITING_CONFIRM_TERJEMAH');
  console.log(`✅ Bacaan Arab terkirim ke ${jid}: ${bacaan.surat_ayat} (kode=${bacaan.kode}, urutan=${nextUrutan})`);
}

async function kirimBacaanTerjemahSaja(jid) {
  const user = getUser(jid);

  const urutanMin = getUrutanMin();
  const urutanMax = getUrutanMax();
  let nextUrutan = (user.last_sent_bacaan_id || 0) + 1;
  if (nextUrutan > urutanMax) {
    nextUrutan = urutanMin;
  }

  const bacaan = getBacaanByUrutan(nextUrutan);
  if (!bacaan) {
    await sock.sendMessage(jid, { text: 'Maaf, data bacaan belum tersedia saat ini 🙏' });
    console.log(`⚠️  Bacaan urutan=${nextUrutan} tidak ditemukan (mode terjemah-saja).`);
    return;
  }

  try {
    await sock.sendMessage(jid, {
      image: { url: path.join(__dirname, pathIndoDariKode(bacaan.kode)) },
      caption: PESAN_SETELAH_YA_TERJEMAH_TEMPLATE(bacaan.surat_ayat),
    });
  } catch (err) {
    console.error('❌ Gagal kirim bacaan terjemah-saja:', err.message);
    return;
  }

  if (!user.tanggal_mulai_baca) {
    setTanggalMulaiBaca(jid, new Date().toISOString().slice(0, 10));
  }

  updateLastSentBacaanId(jid, nextUrutan);
  console.log(`✅ Terjemah-saja terkirim ke ${jid}: ${bacaan.surat_ayat} (kode=${bacaan.kode}, urutan=${nextUrutan})`);

  await cekKecepatanDanTawarkanLanjut(jid);
}

// ========== FUNGSI UNTUK AGENT (dipanggil tools.js lewat konteks) ==========
// Sengaja independen dari kirimBacaanArab/kirimBacaanTerjemahSaja di atas
// (yang masih dipakai flow state lama) supaya tidak saling pengaruh selama migrasi bertahap.
// Akan di-cleanup/di-dedup di Step 10 setelah flow lama resmi dibuang.

async function kirimGambarBacaanMentah(jid, bacaan, jenis) {
  const relPath = jenis === 'arab' ? pathArabDariKode(bacaan.kode) : pathIndoDariKode(bacaan.kode);
  const caption = jenis === 'arab'
    ? PESAN_SETELAH_YA_ARAB_TEMPLATE(bacaan.surat_ayat)
    : PESAN_SETELAH_YA_TERJEMAH_TEMPLATE(bacaan.surat_ayat);
  try {
    await sock.sendMessage(jid, { image: { url: path.join(__dirname, relPath) }, caption });
    return true;
  } catch (err) {
    console.error(`❌ Gagal kirim bacaan ${jenis} (agent):`, err.message);
    return false;
  }
}

function hitungStatusPaceUntukAgent(jid) {
  const sisa = hitungSisaProgressUser(jid);
  if (!sisa.ada_target) return { status: 'NORMAL', selisihTampilan: null };
  return { status: sisa.status, selisihTampilan: sisa.selisih_tampilan };
}

function buatCatatanSetelahKirimBacaan(modeArabSaja, statusPace, target, selisihTampilan) {
  const bagianMode = modeArabSaja
    ? 'Bacaan Arab sudah terkirim. Tawarkan dengan natural apakah user mau lanjut baca terjemahnya juga (pakai tool kirim_terjemah_bacaan kalau user mau).'
    : 'Bacaan terjemah-saja sudah terkirim (user sedang dalam mode halangan).';

  let bagianPace = '';
  if (statusPace === 'DI_BAWAH_PACE') {
    bagianPace = ` User punya target cepat (1 juz per ${target} hari) dan masih ${selisihTampilan} dari target hari ini. Sebutkan angka ini APA ADANYA (jangan dikonversi ulang), semangati, dan tawarkan apakah mau lanjut baca kartu berikutnya sekarang juga.`;
  } else if (statusPace === 'SUDAH_CAPAI_PACE') {
    // Tetap apresiasi jelas (poin 1), TAPI tetap tawarkan lanjut, bukan ditutup.
    bagianPace = ` User SUDAH mencapai 100% target pace hari ini (1 juz per ${target} hari), malah ${selisihTampilan} dari target. WAJIB sebutkan eksplisit bahwa target hari ini sudah tercapai/100% (jangan cuma tersirat) dan beri apresiasi hangat. Setelah itu tetap tanyakan apakah user mau lanjut baca kartu berikutnya (sebagai bonus, bukan kewajiban) atau cukup dulu -- JANGAN langsung menyimpulkan sesi selesai.`;
  }

  return bagianMode + bagianPace;
}

async function kirimBacaanLanjutanUntukAgent(jid) {
  const user = getUser(jid);

  if (user.bentuk_bacaan === 'reminder') {
    const teks = `Waktunya tilawah, ${user.name || 'Sahabat'} 📖 Yuk lanjut baca dari mushaf/app kamu sendiri ya, Dawam cuma ngingetin aja.`;
    try {
      await sock.sendMessage(jid, { text: teks });
    } catch (err) {
      console.error('❌ Gagal kirim reminder bacaan:', err.message);
      return { sukses: false, pesan: 'Gagal mengirim reminder.' };
    }
    resetNoResponse(jid);
    console.log(`✅ [Agent] Reminder-saja terkirim ke ${jid} (mode bentuk_bacaan='reminder').`);
    return {
      sukses: true,
      mode: 'reminder_saja',
      catatan_untuk_ai: 'User sedang mode reminder-saja (tanpa kartu gambar), jadi posisi TIDAK otomatis bertambah. Kalau user lapor progress manual, cukup tanggapi natural tanpa tool set_posisi_bacaan.',
    };
  }

  const urutanMin = getUrutanMin();
  const urutanMax = getUrutanMax();
  const urutanSebelumWrap = (user.last_sent_bacaan_id || 0) + 1;
  let nextUrutan = urutanSebelumWrap;
  if (nextUrutan > urutanMax) nextUrutan = urutanMin;

  const bacaan = getBacaanByUrutan(nextUrutan);
  if (!bacaan) {
    console.log(`⚠️  Bacaan urutan=${nextUrutan} tidak ditemukan (agent).`);
    return { sukses: false, pesan: 'Data bacaan belum tersedia saat ini.' };
  }

  const modeArabSaja = user.mode_baca_arab_saja === 1;
  const jenisDikirim = modeArabSaja ? 'arab' : 'indo';
  const terkirim = await kirimGambarBacaanMentah(jid, bacaan, jenisDikirim);
  if (!terkirim) {
    return { sukses: false, pesan: 'Gagal mengirim gambar bacaan.' };
  }

  const startBacaanId = user.start_bacaan_id || 0;
  const barusanKhatam = sudahKhatamSetelahWrap(startBacaanId, urutanSebelumWrap, nextUrutan);
  if (barusanKhatam) {
    setStartBacaanId(jid, nextUrutan - 1 < urutanMin ? urutanMax : nextUrutan - 1);
  }

  const hariIniISO = new Date().toISOString().slice(0, 10);
  if (!user.tanggal_mulai_baca) {
    setTanggalMulaiBaca(jid, hariIniISO);
  }
  setTanggalTerakhirBaca(jid, hariIniISO);
  updateLastSentBacaanId(jid, nextUrutan);
  resetNoResponse(jid);

  const { status: statusPace, selisihTampilan } = hitungStatusPaceUntukAgent(jid);
  catatLogBacaanHarian(jid, hariIniISO, nextUrutan, bacaan.surat_ayat, statusPace);
  console.log(`✅ [Agent] Bacaan ${jenisDikirim} terkirim ke ${jid}: ${bacaan.surat_ayat} (kode=${bacaan.kode}, urutan=${nextUrutan})`);

  return {
    sukses: true,
    surat_ayat: bacaan.surat_ayat,
    juz: bacaan.juz,
    jenis_dikirim: jenisDikirim,
    barusan_khatam: barusanKhatam,
    catatan_untuk_ai: barusanKhatam
      ? `User BARU SAJA KHATAM! Muter penuh dari titik mulainya dan sekarang kembali ke sana. Ucapkan selamat/apresiasi besar atas pencapaian khatamnya dengan hangat, sebelum lanjut ke catatan progress biasa berikut: ${buatCatatanSetelahKirimBacaan(modeArabSaja, statusPace, user.target_juz_per_hari, selisihTampilan)}`
      : buatCatatanSetelahKirimBacaan(modeArabSaja, statusPace, user.target_juz_per_hari, selisihTampilan),
  };
}

async function kirimTerjemahBacaanUntukAgent(jid) {
  const user = getUser(jid);
  const bacaan = getBacaanByUrutan(user.last_sent_bacaan_id);
  if (!bacaan) {
    return { sukses: false, pesan: 'Belum ada bacaan Arab yang terkirim sebelumnya untuk diterjemahkan.' };
  }

  const terkirim = await kirimGambarBacaanMentah(jid, bacaan, 'indo');
  if (!terkirim) {
    return { sukses: false, pesan: 'Gagal mengirim gambar terjemah.' };
  }

  const { status: statusPace, selisihTampilan } = hitungStatusPaceUntukAgent(jid);
  let catatan = 'Terjemah sudah terkirim.';
  if (statusPace === 'DI_BAWAH_PACE') {
    catatan += ` User masih ${selisihTampilan} dari target (1 juz per ${user.target_juz_per_hari} hari), tawarkan lanjut baca kartu berikutnya.`;
  } else if (statusPace === 'SUDAH_CAPAI_PACE') {
    catatan += ` User sudah capai pace hari ini, malah ${selisihTampilan} dari target. Beri apresiasi dan cukupkan sesi.`;
  }

  console.log(`✅ [Agent] Terjemah terkirim ke ${jid}: ${bacaan.surat_ayat}`);
  return { sukses: true, surat_ayat: bacaan.surat_ayat, catatan_untuk_ai: catatan };
}

// ---- Lelang Isya (poin 1): kirim card LANJUTAN milik pemilikJid, tapi PERSONAL ke penerimaJid ----
async function kirimCardLelangPersonal(penerimaJid, pemilikJid) {
  const pemilik = getUser(pemilikJid);
  const urutanMin = getUrutanMin();
  const urutanMax = getUrutanMax();
  let nextUrutan = (pemilik.last_sent_bacaan_id || 0) + 1;
  if (nextUrutan > urutanMax) nextUrutan = urutanMin;

  const bacaan = getBacaanByUrutan(nextUrutan);
  if (!bacaan) {
    return { sukses: false, pesan: 'Data bacaan pemilik card tidak ditemukan.' };
  }

  const jenisDikirim = pemilik.mode_baca_arab_saja === 1 ? 'arab' : 'indo';
  const terkirim = await kirimGambarBacaanMentah(penerimaJid, bacaan, jenisDikirim);
  if (!terkirim) {
    return { sukses: false, pesan: 'Gagal mengirim gambar card lelang.' };
  }

  console.log(`✅ [Lelang] Card ${pemilik.name || pemilikJid} (${bacaan.surat_ayat}) dikirim personal ke ${penerimaJid}`);
  return { sukses: true, surat_ayat: bacaan.surat_ayat };
}

// ---- Broadcast tawaran lelang ke grup, dipanggil cron jam 19:00 SEBELUM rekap harian ----
async function kirimTawaranLelangKeGrup(groupJid) {
  const diBawahPace = getAnggotaDiBawahPaceHariIni(groupJid);

  // Tetap siapkan data lelang di belakang layar (biar klaim_card_kawan tetap bisa jalan),
  // TAPI teks pengumuman lelang ke grup dihilangkan dulu.
  if (diBawahPace.length > 0) {
    setTawaranLelangGrup(groupJid, diBawahPace);
  }

  // Yang dikirim ke grup sekarang laporan harian (persen + kurang berapa halaman),
  // pindah dari jam 20:00 ke jam Isya.
  await kirimRekapHarianKeGrup(groupJid, false, true);
}

// ---- §4.3: Deteksi kecepatan & tawaran lanjut ----
async function cekKecepatanDanTawarkanLanjut(jid) {
  const user = getUser(jid);
  const nama = getUserName(jid) || 'Sahabat Dawam';

  const sisa = hitungSisaProgressUser(jid);
  if (!sisa.ada_target) {
    await tutupSesiBaca(jid, nama);
    setUserState(jid, 'IDLE');
    return;
  }

  if (sisa.status === 'DI_BAWAH_PACE') {
    let pesan = await groqAI.generateTawaranLanjutSesi(nama, user.target_juz_per_hari);
    if (!pesan) {
      pesan = `Mantap, ${nama}! Mau lanjut baca lagi sekarang biar makin dekat ke target ${user.target_juz_per_hari} hari/juz, atau cukup dulu?`;
    }
    await sock.sendMessage(jid, { text: pesan });
    setUserState(jid, 'WAITING_LANJUT_SESI');
  } else {
    // SUDAH_CAPAI_PACE / PAS_PACE (100% target hari ini): tetap kasih tau + apresiasi,
    // TAPI tetap tawarkan lanjut (bukan ditutup otomatis) -- poin 1 note terbaru.
    let pesan = await groqAI.generateSudahCapaiPace(nama, user.target_juz_per_hari);
    if (!pesan) {
      pesan = `Alhamdulillah, ${nama} udah 100% target hari ini (1 juz per ${user.target_juz_per_hari} hari) 🎉 Mau lanjut baca kartu berikutnya (bonus), atau cukup dulu untuk sesi ini?`;
    }
    await sock.sendMessage(jid, { text: pesan });
    setUserState(jid, 'WAITING_LANJUT_SESI');
  }
}

async function tutupSesiBaca(jid, nama) {
  let pesan = await groqAI.generatePenutupSesiBiasa(nama);
  if (!pesan) {
    pesan = `Barakallahu fiik, ${nama} 🤍 Sampai jumpa lagi di waktu sholat berikutnya.`;
  }
  await sock.sendMessage(jid, { text: pesan });
}

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
  simpanChatHistory(jid, 'assistant', pesan);

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

// ========== FUNGSI-FUNGSI TRIGGER REMINDER PERSONAL ==========

async function kirimReminderSholat(waktuSholat, jid) {
  if (!PESAN_REMINDER_SHOLAT[waktuSholat]) {
    console.log(`⚠️  Waktu sholat "${waktuSholat}" tidak dikenali.`);
    return;
  }

  getOrCreateUser(jid);
  const user = getUser(jid);
  if (user.reminder_sholat_aktif === 0) {
    console.log(`(Reminder sholat nonaktif untuk ${jid}, dilewati.)`);
    return;
  }

  const nama = getUserName(jid) || 'Sahabat Dawam';

  let pesan = await groqAI.generateReminderSholat(waktuSholat, nama);
  if (!pesan) {
    console.log('⚠️  AI gagal/kosong, pakai template statis sebagai fallback.');
    pesan = PESAN_REMINDER_SHOLAT[waktuSholat];
  }

  await sock.sendMessage(jid, { text: pesan });
  simpanChatHistory(jid, 'assistant', pesan);
  console.log(`✅ Reminder ${waktuSholat} terkirim ke ${jid}`);

  if (user.tawaran_tilawah_aktif === 0) {
    console.log(`(Tawaran tilawah nonaktif untuk ${jid}, dilewati.)`);
    return;
  }

  console.log(`⏳ Menjadwalkan tawaran ngaji dalam ${JEDA_TAWARAN_MS / 1000} detik...`);
  setTimeout(() => kirimTawaranNgaji(jid), JEDA_TAWARAN_MS);
}

async function kirimTawaranNgaji(jid) {
  const user = getUser(jid);
  const nama = getUserName(jid) || 'Sahabat Dawam';

  const belumPernahDitawarkanMode = user.gender === 'P' && !user.waktu_tawaran_terakhir;

  let pesan;
  if (belumPernahDitawarkanMode) {
    pesan = await groqAI.generateTawaranNgajiUntukP(nama);
  } else {
    pesan = await groqAI.generateTawaranNgaji(nama);
  }
  if (!pesan) {
    console.log('⚠️  AI gagal/kosong, pakai template statis sebagai fallback.');
    pesan = PESAN_TAWARAN_NGAJI_TEMPLATE(nama);
  }

  await sock.sendMessage(jid, { text: pesan });
  simpanChatHistory(jid, 'assistant', pesan);
  setUserState(jid, 'WAITING_CONFIRM');
  setSudahLaporSesiIni(jid, false);
  setWaktuTawaranTerakhir(jid, new Date().toISOString());
  console.log(`✅ Tawaran ngaji terkirim ke ${jid}, menunggu balasan...`);
}

// ========== REMINDER JUMAT KHUSUS LAKI-LAKI (poin 5) ==========
// 15 menit sebelum waktu Dzuhur Jumat, HANYA untuk gender L, pesan khusus sholat Jumat
// (bukan reminder Dzuhur biasa yang generik).

async function kirimReminderJumatLaki(jid) {
  const nama = getUserName(jid) || 'Sahabat Dawam';
  const teks = `Assalamu'alaikum, ${nama} 🕌\n\n15 menit lagi menuju waktu sholat Jumat. Yuk bersiap, segerakan ke masjid ya, Akhi.\n\n"Hai orang-orang beriman, apabila diseru untuk menunaikan shalat Jum'at, maka bersegeralah kamu kepada mengingat Allah." (QS. Al-Jumu'ah: 9)`;
  await sock.sendMessage(jid, { text: teks });
  simpanChatHistory(jid, 'assistant', teks);
  console.log(`✅ Reminder Jumat (laki-laki) terkirim ke ${jid}`);
}

let reminderJumatLakiSchedulerSudahDiset = false;

function setupReminderJumatLakiScheduler() {
  if (reminderJumatLakiSchedulerSudahDiset) return;
  reminderJumatLakiSchedulerSudahDiset = true;

  let menitDzuhur = JADWAL_SHOLAT.dzuhur.menit - 15;
  let jamDzuhur = JADWAL_SHOLAT.dzuhur.jam;
  if (menitDzuhur < 0) {
    menitDzuhur += 60;
    jamDzuhur -= 1;
  }

  // "* * 5" -- hari Jumat saja (0=Minggu ... 5=Jumat di node-cron)
  const cronExpr = `${menitDzuhur} ${jamDzuhur} * * 5`;

  cron.schedule(cronExpr, async () => {
    console.log('\n🕌 Mengirim reminder Jumat (laki-laki)...');
    const targets = getAllUsers().filter(
      (u) => u.is_registered === 1 && u.is_active === 1 && u.gender === 'L' && u.reminder_jumat_laki_aktif !== 0
    ); // <-- tambahan filter reminder_jumat_laki_aktif
    if (targets.length === 0) {
      console.log('⚠️  Tidak ada user laki-laki teraktivasi, reminder Jumat dilewati.');
      return;
    }
    for (const u of targets) {
      await kirimReminderJumatLaki(u.jid);
    }
  });

  console.log(`🕒 Reminder Jumat (laki-laki) diset jam ${jamDzuhur}:${String(menitDzuhur).padStart(2, '0')} tiap Jumat (15 menit sebelum Dzuhur).`);
}

// ========== GRUP: MURNI RUANG SOSIAL (phase 3) ==========
// Bacaan TIDAK PERNAH dikirim ke grup. Grup cuma tempat lapor progress,
// saling menyemangati, dan ngobrol soal tilawah. Bot silent di grup kecuali
// di-tag/mention/reply, atau sedang dalam flow setup yang aktif.

async function handleIncomingGroupMessage(groupJid, senderJid, text, message) {
  const group = getGroup(groupJid);
  const ditag = apakahBotDitag(message);

  // Keyword aktivasi grup -- siapa saja di grup bisa trigger setup
  if (text === KEYWORD_AKTIVASI && (!group || group.is_aktif === 0)) {
    aktifkanGroup(groupJid);

    // Ambil roster lengkap grup via Baileys, supaya SEMUA anggota tercatat di
    // group_members sejak hari pertama -- bukan cuma yang pernah ngetik di grup.
    // JANGAN insert senderJid mentah di sini -- biarkan roster (sudah dinormalisasi
    // ke @s.whatsapp.net) jadi satu-satunya sumber, supaya tidak ada duplikasi JID
    // untuk orang yang sama (kasus Mirza: @lid vs @s.whatsapp.net).
    try {
      const metadata = await sock.groupMetadata(groupJid);
      const participantJids = (metadata.participants || [])
        .map(normalizeParticipantJid)
        .filter((jid) => !apakahJidBot(jid)); // bot sendiri tidak dihitung sebagai anggota
      for (const participantJid of participantJids) {
        tambahAnggotaGroup(groupJid, participantJid);
      }
      console.log(`✅ Roster grup ${groupJid} diambil: ${participantJids.length} anggota tercatat (bot dikecualikan).`);
    } catch (err) {
      console.error('❌ Gagal ambil groupMetadata saat aktivasi:', err.message);
    }

    let pesan = await groqAI.generatePerkenalanGroupSosial();
    if (!pesan) pesan = PESAN_GROUP_SETUP_FALLBACK;
    await sock.sendMessage(groupJid, { text: pesan });
    console.log(`✅ Grup ${groupJid} aktif sebagai ruang sosial.`);

    // Ajak orang yang mengaktifkan grup untuk onboarding personal dulu,
    // kalau dia belum terdaftar di chat pribadi.
    if (!isUserRegistered(senderJid)) {
      try {
        await sock.sendMessage(senderJid, {
          text: `Assalamu'alaikum 🌙 Terima kasih sudah mengaktifkan Dawam di grup tadi!\n\nSupaya Dawam bisa kenalan dan temani tilawah harianmu secara personal juga, yuk kirim kata *"dawam"* di chat pribadi ini ya 😊`,
        });
        console.log(`✅ Ajakan onboarding personal terkirim ke ${senderJid} (pengaktivasi grup ${groupJid}).`);
      } catch (err) {
        console.error('❌ Gagal kirim ajakan onboarding personal ke pengaktivasi grup:', err.message);
      }
    }

    return;
  }

  if (!group || group.is_aktif === 0) {
    // Grup belum aktif dan bukan keyword aktivasi -> selalu silent.
    return;
  }

  if (!ditag) {
    // Grup sudah aktif tapi bot tidak di-tag -> tetap silent, sesuai requirement
    // "jangan muncul terus, cuma pas di-tag". Tidak ada state grup yang menunggu
    // jawaban spesifik tanpa tag, karena grup tidak punya flow kirim-bacaan/tawaran.
    return;
  }

  // Normalisasi senderJid juga di sini -- kalau WA kirim dalam bentuk @lid padahal
  // orang ini sudah tercatat sebagai @s.whatsapp.net (dari roster/onboarding), JANGAN
  // bikin entitas baru. Coba cari existing match dulu sebelum insert.
  const senderJidTernormalisasi = await resolveSenderJidViaGroupMetadata(groupJid, senderJid);
  tambahAnggotaGroup(groupJid, senderJidTernormalisasi);
  setGroupSosialJikaBelumAda(senderJidTernormalisasi, groupJid);
  await routeGroupMessage(groupJid, senderJidTernormalisasi, text);
}
async function routeGroupMessage(groupJid, senderJid, text) {
  const namaSender = getUserName(senderJid) || null;
  const senderBelumOnboarding = !isUserRegistered(senderJid);

  if (!text || text.length < 2) {
    console.log('(Pesan grup terlalu pendek/kosong, diabaikan)');
    return;
  }

  simpanChatHistory(groupJid, 'user', `${namaSender || 'Seseorang'}: ${text}`, senderJid);

  const konteks = {
    groupJid,
    senderJid,
    kirimKeGrup: async (targetGroupJid, text) => {
      try {
        await sock.sendMessage(targetGroupJid, { text });
        return true;
      } catch (err) {
        console.error('❌ Gagal kirim ke grup (broadcast):', err.message);
        return false;
      }
    },
    kirimRekapHarian: async (targetGroupJid) => kirimRekapHarianKeGrup(targetGroupJid, true, true),
    kirimTagKeGrup: (targetGroupJid, pesan, jidList) => kirimTagKeGrup(targetGroupJid, pesan, jidList),
    ambilTawaranLelangAktif: (targetGroupJid, namaTarget) => ambilTawaranLelangAktif(targetGroupJid, namaTarget),
    kirimCardLelangPersonal: (penerimaJid, pemilikJid) => kirimCardLelangPersonal(penerimaJid, pemilikJid),
    tandaiTawaranSudahDiklaim: (targetGroupJid, userJid) => tandaiTawaranSudahDiklaim(targetGroupJid, userJid),
  };

  const hasil = await jalankanAgentDawam({
    systemPrompt: buatPromptGrup(namaSender, senderBelumOnboarding),
    tools: TOOLS_GRUP,
    historiChat: getChatHistory(groupJid, 15),
    pesanBaru: text,
    eksekutorTools: EKSEKUTOR_GRUP,
    konteks,
  });

  if (hasil.error || !hasil.jawabanFinal) {
    console.log(`⚠️  Agent grup gagal/kosong untuk ${groupJid}: ${hasil.error}`);
    await sock.sendMessage(groupJid, { text: PESAN_TIDAK_DIMENGERTI });
    return;
  }

  await sock.sendMessage(groupJid, { text: hasil.jawabanFinal });
  simpanChatHistory(groupJid, 'assistant', hasil.jawabanFinal);
  catatAktivitasGroup(groupJid, senderJid, 'LAPOR_PROGRESS', text.slice(0, 200));
}

// ---- Rekap MINGGUAN asli ke grup aktif, tiap Jumat (poin 2) ----
// Beda dari rekap harian: agregat 7 hari terakhir per anggota, lebih deskriptif.
let groupMotivasiSchedulerSudahDiset = false;

function formatRekapMingguanTerstruktur(groupJid) {
  const anggotaJids = getAnggotaGroup(groupJid);
  const hariIni = new Date();
  const tanggalSelesai = hariIni.toISOString().slice(0, 10);
  const tanggalMulai = new Date(hariIni);
  tanggalMulai.setDate(tanggalMulai.getDate() - 6);
  const tanggalMulaiISO = tanggalMulai.toISOString().slice(0, 10);

  const baris = [];
  let adaDataSamaSekali = false;

  for (const jid of anggotaJids) {
    const user = getUser(jid);
    if (user.is_registered !== 1) continue;

    const logMingguIni = getLogBacaanHarianRange(jid, tanggalMulaiISO, tanggalSelesai);
    const totalKartu = logMingguIni.reduce((acc, l) => acc + l.jumlah_kartu, 0);
    const hariAktif = logMingguIni.length;

    if (totalKartu > 0) adaDataSamaSekali = true;

    const sisa = hitungSisaProgressUser(jid);
    const posisiAkhir = logMingguIni.length > 0
      ? logMingguIni[logMingguIni.length - 1].surat_ayat_akhir
      : 'belum ada bacaan minggu ini';

    // Persen mingguan WAJIB (poin 2): rata-rata dari persen harian minggu ini (sisa capai
    // target = 100%, lihat hitungSisaProgressUser). Kalau target user santai ('6'/belum ada),
    // tidak ada angka harian yang relevan sama sekali -> null ("-"), BUKAN 0%.
    let persenMingguan = null;
    if (sisa.ada_target) {
      // Reuse status_pace_akhir yang disimpan tiap hari di log_bacaan_harian sebagai proxy:
      // SUDAH_CAPAI_PACE/PAS_PACE dihitung 100% hari itu, DI_BAWAH_PACE dihitung dari snapshot
      // hari ini (sisa.persen_pace) sebagai representasi rata-rata kasar.
      const hariCapaiTarget = logMingguIni.filter(
        (l) => l.status_pace_akhir === 'SUDAH_CAPAI_PACE' || l.status_pace_akhir === 'PAS_PACE'
      ).length;
      const totalHariDenganData = logMingguIni.filter((l) => l.status_pace_akhir !== null).length;
      persenMingguan = totalHariDenganData > 0
        ? Math.round((hariCapaiTarget / totalHariDenganData) * 100)
        : (sisa.persen_pace ?? 0);
    }

    baris.push({
      nama: user.name || 'Sahabat',
      hari_aktif: hariAktif,
      total_kartu: totalKartu,
      posisi_akhir_minggu: posisiAkhir,
      persen_pace_mingguan: persenMingguan,
      status_pace_sekarang: sisa.status || null,
    });
  }

  if (!adaDataSamaSekali && baris.length === 0) return null;

  let teks = `📅 *Rekap Tilawah Minggu Ini* (${tanggalMulaiISO} s/d ${tanggalSelesai})\n\n`;
  for (const b of baris) {
    const emoji = b.hari_aktif >= 6 ? '🔥' : b.hari_aktif >= 3 ? '📖' : b.hari_aktif > 0 ? '🌱' : '💤';
    const persenTampilan = b.persen_pace_mingguan !== null ? `${b.persen_pace_mingguan}%` : '-';
    teks += `${emoji} *${b.nama}* — aktif ${b.hari_aktif}/7 hari, ${b.total_kartu} kartu dibaca\n`;
    teks += `   posisi akhir minggu: ${b.posisi_akhir_minggu} (rata-rata ${persenTampilan} capaian target harian minggu ini)`;
    teks += '\n\n';
  }

  return teks.trim();
}

function setupGroupMotivasiScheduler() {
  if (groupMotivasiSchedulerSudahDiset) return;
  groupMotivasiSchedulerSudahDiset = true;

  cron.schedule(INTERVAL_CRON_MOTIVASI_GROUP, async () => {
    console.log('\n📅 Mengirim rekap mingguan ke grup aktif...');
    const grupAktif = getAllGroupsAktif();

    if (grupAktif.length === 0) {
      console.log('(Tidak ada grup aktif saat ini)');
      return;
    }

    for (const g of grupAktif) {
      const teksRekap = formatRekapMingguanTerstruktur(g.jid);
      if (!teksRekap) {
        console.log(`(Grup ${g.jid}: belum ada anggota aktivasi, rekap mingguan dilewati.)`);
        continue;
      }

      let kalimatPenutup = await groqAI.generateKalimatMotivasiRekapHarian(false);
      const pesanFinal = kalimatPenutup ? `${teksRekap}\n\n${kalimatPenutup}` : teksRekap;

      await sock.sendMessage(g.jid, { text: pesanFinal });
      setGroupWaktuMotivasiTerakhir(g.jid, new Date().toISOString());
      console.log(`✅ Rekap mingguan terkirim ke grup ${g.jid}`);
    }
  });

  console.log(`🕒 Group rekap mingguan scheduler diset (${INTERVAL_CRON_MOTIVASI_GROUP}).`);
}

// ---- Rekap harian progress ke grup aktif, jam 20:00 (poin 1) ----
let rekapHarianSchedulerSudahDiset = false;

// Anggota yang sudah aktivasi tapi belum baca hari ini -- kandidat untuk di-tag.
function ambilJidBelumBacaHariIni(dataRekap) {
  return dataRekap
    .filter((d) => d.sudah_aktivasi_personal && !d.sudah_baca_hari_ini)
    .map((d) => d.jid);
}

// Bangun teks rekap harian secara deterministik (bukan dikarang AI tiap kali) supaya
// formatnya konsisten dan angkanya pasti akurat -- AI cuma nambahin kalimat motivasi.
function formatRekapHarianTerstruktur(dataRekap, sertakanTagBelumBaca = false) {
  const sudahAktif = dataRekap.filter((d) => d.sudah_aktivasi_personal);
  const belumAktif = dataRekap.filter((d) => !d.sudah_aktivasi_personal);

  if (sudahAktif.length === 0) return { teks: null, jidUntukMention: [] };

  let teks = '📊 *Rekap Tilawah Hari Ini*\n\n';

  for (const d of sudahAktif) {
    let persenTampilan;
    if (d.persen_pace !== null && d.persen_pace !== undefined) {
      persenTampilan = `${d.persen_pace}%`;
    } else if (!d.sudah_baca_hari_ini) {
      persenTampilan = '0%';
    } else {
      persenTampilan = '-';
    }

    const emoji = d.persen_pace === 0 || persenTampilan === '0%' ? '💤' : d.status_pace === 'SUDAH_CAPAI_PACE' ? '🎉' : d.status_pace === 'DI_BAWAH_PACE' ? '📖' : '✅';

    // Keterangan halaman -- cuma ditampilkan kalau user punya target harian.
    let keteranganHalaman = '';
    if (d.halaman_target_hari_ini !== null && d.halaman_target_hari_ini !== undefined) {
      const ditempuh = d.halaman_ditempuh_hari_ini ?? 0;
      keteranganHalaman = ` (${ditempuh}/${d.halaman_target_hari_ini} halaman)`;
    }

    teks += `${emoji} *${d.nama}* — ${persenTampilan} dari target harian${keteranganHalaman}\n\n`;
  }

  if (belumAktif.length > 0) {
    teks += `⏳ Ada ${belumAktif.length} anggota yang belum aktivasi personal, kirim "dawam" ke chat pribadi biar progressnya ikut tercatat.\n\n`;
  }

  let jidUntukMention = [];
  if (sertakanTagBelumBaca) {
    const jidBelumBaca = ambilJidBelumBacaHariIni(dataRekap);
    if (jidBelumBaca.length > 0) {
      const namaBelumBaca = dataRekap.filter((d) => jidBelumBaca.includes(d.jid));
      const tagText = namaBelumBaca.map((d) => `@${d.jid.split('@')[0]}`).join(' ');
      teks += `🤍 Yuk mampir sebentar sebelum Isya, belum sempat baca hari ini: ${tagText}`;
      jidUntukMention = jidBelumBaca;
    }
  }

  return { teks: teks.trim(), jidUntukMention };
}

let lelangIsyaSchedulerSudahDiset = false;

function setupLelangIsyaScheduler() {
  if (lelangIsyaSchedulerSudahDiset) return;
  lelangIsyaSchedulerSudahDiset = true;

  cron.schedule(INTERVAL_CRON_LELANG_ISYA, async () => {
    console.log('\n🔔 Mengirim tawaran lelang Isya ke grup aktif...');
    const grupAktif = getAllGroupsAktif();

    if (grupAktif.length === 0) {
      console.log('(Tidak ada grup aktif saat ini)');
      return;
    }

    for (const g of grupAktif) {
      await kirimTawaranLelangKeGrup(g.jid);
    }
  });

  console.log(`🕒 Lelang Isya scheduler diset (${INTERVAL_CRON_LELANG_ISYA}).`);
}

function setupRekapHarianScheduler() {
  if (rekapHarianSchedulerSudahDiset) return;
  rekapHarianSchedulerSudahDiset = true;

  cron.schedule(INTERVAL_CRON_REKAP_HARIAN, async () => {
    console.log('\n📊 Mengirim rekap harian ke grup aktif...');
    const grupAktif = getAllGroupsAktif();

    if (grupAktif.length === 0) {
      console.log('(Tidak ada grup aktif saat ini)');
      return;
    }

    for (const g of grupAktif) {
      await kirimRekapHarianKeGrup(g.jid, false, true);
    }
  });

  console.log(`🕒 Rekap harian scheduler diset (${INTERVAL_CRON_REKAP_HARIAN}).`);
}

// Dipakai cron DAN trigger manual (lewat tool grup) -- satu sumber logic.
async function kirimRekapHarianKeGrup(groupJid, modeManual, sertakanTagBelumBaca = true) {
  const dataRekap = getRekapProgressGroup(groupJid);
  const { teks: teksRekap, jidUntukMention } = formatRekapHarianTerstruktur(dataRekap, sertakanTagBelumBaca);

  if (!teksRekap) {
    console.log(`(Rekap harian grup ${groupJid} dilewati -- belum ada anggota yang aktivasi.)`);
    return { terkirim: false, jidUntukMention: [] };
  }

  const adaYangDiBawahPace = dataRekap.some((d) => d.status_pace === 'DI_BAWAH_PACE');
  const kalimatMotivasi = await groqAI.generateKalimatMotivasiRekapHarian(adaYangDiBawahPace);

  const pesanFinal = kalimatMotivasi ? `${teksRekap}\n\n${kalimatMotivasi}` : teksRekap;

  try {
    await sock.sendMessage(groupJid, { text: pesanFinal, mentions: jidUntukMention });
    console.log(`✅ Rekap harian terkirim ke grup ${groupJid} (manual=${modeManual}, tag=${jidUntukMention.length})`);
    return { terkirim: true, jidUntukMention };
  } catch (err) {
    console.error('❌ Gagal kirim rekap harian ke grup:', err.message);
    return { terkirim: false, jidUntukMention: [] };
  }
}

// Kirim pesan ke grup dengan mention anggota tertentu -- generik, dipakai untuk
// berbagai kriteria tag (belum aktivasi, belum baca hari ini, orang spesifik, dll),
// AI yang tentukan jidList-nya dari data get_rekap_progress_grup.
async function kirimTagKeGrup(groupJid, pesanPembuka, jidList) {
  const tagText = jidList.map((jid) => `@${jid.split('@')[0]}`).join(' ');
  const teks = `${pesanPembuka}\n\n${tagText}`;
  try {
    await sock.sendMessage(groupJid, { text: teks, mentions: jidList });
    console.log(`✅ Tag terkirim ke grup ${groupJid} untuk ${jidList.length} orang.`);
    return true;
  } catch (err) {
    console.error('❌ Gagal kirim tag ke grup:', err.message);
    return false;
  }
}

// ========== JUMAT AL-KAHFI (poin 3) ==========
// Tiap Jumat pagi, tawarkan mulai/lanjut cicilan Al-Kahfi -- terpisah dari progress
// khataman utama. Posisi disimpan di last_sent_alkahfi_id (bukan last_sent_bacaan_id).

function getBacaanAlkahfiByUrutan(urutan) {
  const row = db.prepare('SELECT * FROM bacaan WHERE urutan = ? AND surat_ayat LIKE ?').get(urutan, 'Al-Kahf%');
  return row || null;
}
async function kirimTawaranAlkahfi(jid) {
  const user = getUser(jid);
  const nama = getUserName(jid) || 'Sahabat Dawam';
  const teks = `Selamat hari Jumat, ${nama} 🤍 Yuk sisihkan waktu buat baca Surat Al-Kahfi hari ini, dicicil pelan-pelan juga gapapa. Balas *"ya"* kalau mau dikirimkan lanjutannya sekarang.`;
  await sock.sendMessage(jid, { text: teks });
  simpanChatHistory(jid, 'assistant', teks);
  setUserState(jid, 'WAITING_KONFIRMASI_ALKAHFI');
  console.log(`✅ Tawaran Al-Kahfi terkirim ke ${jid}`);
}

async function kirimCardAlkahfiLanjutan(jid) {
  const user = getUser(jid);
  let nextUrutan = (user.last_sent_alkahfi_id || 0) + 1;

  let bacaan = getBacaanAlkahfiByUrutan(nextUrutan);
  if (!bacaan) {
    // Habis/belum ada urutan berikutnya dalam rentang Al-Kahfi -- mulai dari awal lagi.
    bacaan = cariBacaanBySuratLike('Al-Kahf');
    if (!bacaan) {
      return { sukses: false, pesan: 'Data bacaan Al-Kahfi tidak ditemukan di database.' };
    }
    nextUrutan = bacaan.urutan;
  }

  try {
    await sock.sendMessage(jid, {
      image: { url: path.join(__dirname, pathArabDariKode(bacaan.kode)) },
      caption: `Lanjutan Al-Kahfi untukmu (${bacaan.surat_ayat}) 🤍`,
    });
  } catch (err) {
    console.error('❌ Gagal kirim card Al-Kahfi:', err.message);
    return { sukses: false, pesan: 'Gagal mengirim gambar.' };
  }

  updateLastSentAlkahfiId(jid, nextUrutan);
  setTanggalTerakhirAlkahfi(jid, new Date().toISOString().slice(0, 10));
  console.log(`✅ Card Al-Kahfi terkirim ke ${jid}: ${bacaan.surat_ayat} (kode=${bacaan.kode}, urutan=${nextUrutan})`);
  return { sukses: true, surat_ayat: bacaan.surat_ayat };
}

let alkahfiJumatSchedulerSudahDiset = false;

function setupAlkahfiJumatScheduler() {
  if (alkahfiJumatSchedulerSudahDiset) return;
  alkahfiJumatSchedulerSudahDiset = true;

  cron.schedule(INTERVAL_CRON_ALKAHFI_JUMAT, async () => {
    console.log('\n📖 Mengirim tawaran Al-Kahfi Jumat...');
    const targets = getRegisteredTargets();
    if (targets.length === 0) {
      console.log('⚠️  Belum ada user teraktivasi, tawaran Al-Kahfi dilewati.');
      return;
    }
    for (const jid of targets) {
      const user = getUser(jid);
      if (user.tawaran_alkahfi_aktif === 0) continue; // <-- tambahan
      await kirimTawaranAlkahfi(jid);
    }
  });

  console.log(`🕒 Scheduler Al-Kahfi Jumat diset (${INTERVAL_CRON_ALKAHFI_JUMAT}).`);
}

// ========== SCHEDULER OTOMATIS PERSONAL (existing, tidak berubah) ==========

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