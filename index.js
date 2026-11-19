// Seluruh logika tanggal/jadwal Dawam berbasis WIB. Dipasang SEBELUM modul lain dimuat
// supaya cron ('0 20 * * *' = jam 20:00 WIB) dan Date lokal konsisten walau server di UTC.
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

require('dotenv').config();

// Jaring pengaman: promise yang gagal tanpa catch (mis. satu pengiriman WA gagal) cukup dicatat,
// tidak menjatuhkan seluruh proses. Kegagalan fatal saat start/reconnect tetap keluar lewat
// process.exit di startBot().catch(...) di bawah, supaya pm2 yang me-restart.
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});

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
  getAllUsers,
  getOrCreateUser,
  isUserRegistered,
  registerUser,
  getUserName,
  // phase 2
  getBacaanByUrutan,
  getUrutanMin,
  getUrutanMax,
  pathArabDariKode,
  pathIndoDariKode,
  cariBacaanBySuratLike,
  updateLastSentBacaanId,
  setTanggalMulaiBaca,
  setStartBacaanId,
  setTanggalTerakhirBaca,
  sudahKhatamSetelahWrap,
  sudahKhatamSetelahKirim,
  hitungPersenMingguan,
  incrementNoResponse,
  resetNoResponse,
  setWaktuTawaranTerakhir,
  // onboarding conversational
  getFieldOnboardingKosong,
  updateUserFields,
  // phase 3 - groups (sosial)
  getGroup,
  aktifkanGroup,
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
  // tanggal WIB
  tanggalHariIniISO,
  tanggalMundurISO,
  // koneksi SQLite mentah (dipakai getBacaanAlkahfiByUrutan)
  db,
} = require('./db');
const groqAI = require('./groq');
const {
  toolsPersonalUntuk,
  TOOLS_GRUP,
  EKSEKUTOR_PERSONAL,
  EKSEKUTOR_GRUP,
} = require('./tools');
const power = require('./power');
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
    .filter((u) => u.is_registered === 1 && u.is_active === 1 && u.state !== 'ONBOARDING')
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


const PESAN_TAWARAN_NGAJI_TEMPLATE = (nama) =>
  `Semoga shalatnya diterima Allah ﷻ 🤲\n\n${nama}, sudah siap lanjut tilawah hari ini? Yuk sisihkan sedikit waktu untuk membaca Al-Qur'an 📖\n\nBalas *"ya"* untuk lanjut membaca, atau *"nanti"* kalau belum sempat.`;

const CAPTION_KARTU_ARAB = (suratAyat) => suratAyat;
const CAPTION_KARTU_TERJEMAH = (suratAyat) => `Terjemah: ${suratAyat}`;

const PESAN_TIDAK_DIMENGERTI =
  'Maaf, Dawam belum paham maksudnya 🙏 Balas dengan *"ya"* atau *"nanti"* ya, Sahabat.';

// Dipakai HANYA saat agent gagal/timeout (bukan saat user salah jawab), supaya pesannya jujur.
const PESAN_AGENT_GANGGUAN =
  'Maaf, Dawam lagi ada gangguan sebentar 🙏 Coba kirim lagi pesanmu dalam beberapa saat ya, Sahabat.';

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

const PESAN_TANYA_MULAI_SURAT =
  'Mau mulai tilawah dari surat apa? Kalau bebas, bilang "dari awal" aja ya 😊';

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
      if (shouldReconnect) {
        // Jeda singkat supaya tidak loop rapat kalau koneksi terus gagal.
        setTimeout(() => {
          startBot().catch((err) => {
            console.error('❌ Gagal reconnect, keluar supaya di-restart pm2:', err);
            process.exit(1);
          });
        }, 3000);
      } else {
        console.log('⚠️  Sesi WhatsApp logged out. Hapus folder auth_session lalu scan QR ulang.');
      }
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
      setupFeedbackDigestScheduler();
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
    // Proses SEMUA pesan dalam batch (dulu hanya yang pertama, sisanya hilang diam-diam), dan
    // JANGAN filter m.type: pesan yang masuk saat bot offline/restart datang dengan type 'append'.
    for (const message of m.messages || []) {
      try {
        terimaPesanMasuk(message);
      } catch (err) {
        console.error('❌ Error di messages.upsert:', err);
      }
    }
  });

  return sock;
}

// Satu pesan masuk -> disaring -> dimasukkan ke antrean chat-nya masing-masing.
function terimaPesanMasuk(message) {
  if (!message?.message || message.key.fromMe) return;

  const remoteJid = message.key.remoteJid;
  if (!remoteJid) return;
  // Status WA dan channel bukan chat user: jangan dibuatkan baris user / diproses.
  if (remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) return;

  // Pesan yang sama (id sama) tidak diproses dua kali.
  if (pesanSudahDiproses(message)) return;

  const isGroup = remoteJid.endsWith('@g.us');
  const textAsli = ambilTeksPesan(message);
  const text = textAsli.toLowerCase();

  if (isGroup) {
    // Pilih JID @s.whatsapp.net kalau ada (participantAlt di Baileys 7 berisi nomor HP saat
    // participant berupa @lid), supaya konsisten dengan roster dan chat personal tanpa
    // perlu panggil groupMetadata tiap pesan.
    const sender = pilihJidPengirimGrup(message.key);
    if (!sender) return; // tidak bisa identifikasi pengirim, abaikan
    console.log(`\n📩 [GRUP ${remoteJid}] Pesan dari ${sender}: "${text}"`);
    // Antrean per grup+pengirim: pesan beruntun dari orang yang sama diproses berurutan.
    jalankanBerurutan(`${remoteJid}|${sender}`, () =>
      handleIncomingGroupMessage(remoteJid, sender, text, message)
    );
  } else {
    const sender = normalizeJid(message);
    console.log(`\n📩 Pesan masuk dari ${sender}: "${textAsli}"`);
    // Antrean per chat: dua pesan cepat dari user yang sama tidak lagi jalan paralel
    // (mencegah kartu dobel / histori acak-acakan).
    jalankanBerurutan(`dm|${sender}`, () => handleIncomingMessage(sender, textAsli, text));
  }
}

// ========== HELPER PESAN MASUK (antrean, dedupe, unwrap) ==========

// Buka pembungkus "pesan sementara" (disappearing messages) supaya teks/mention di dalamnya
// tetap terbaca. Untuk pesan biasa hasilnya sama persis dengan message.message.
function bukaPembungkusPesan(isi) {
  let cur = isi;
  for (let i = 0; i < 3 && cur?.ephemeralMessage?.message; i++) {
    cur = cur.ephemeralMessage.message;
  }
  return cur;
}

function ambilTeksPesan(message) {
  const isi = bukaPembungkusPesan(message.message);
  return (isi?.conversation || isi?.extendedTextMessage?.text || '').trim();
}

// Di grup, pilih JID berformat @s.whatsapp.net kalau tersedia; fallback ke participant apa adanya.
function pilihJidPengirimGrup(key) {
  const kandidat = [key.senderPn, key.participantAlt, key.participant];
  const pn = kandidat.find((j) => typeof j === 'string' && j.endsWith('@s.whatsapp.net'));
  return pn || key.participant;
}

const ID_PESAN_DIPROSES = new Set();
function pesanSudahDiproses(message) {
  const id = message.key?.id;
  if (!id) return false;
  const kunci = `${message.key.remoteJid}|${id}`;
  if (ID_PESAN_DIPROSES.has(kunci)) return true;
  ID_PESAN_DIPROSES.add(kunci);
  if (ID_PESAN_DIPROSES.size > 1000) ID_PESAN_DIPROSES.delete(ID_PESAN_DIPROSES.values().next().value);
  return false;
}

// Antrean sederhana per kunci (satu chat = satu antrean). Tugas yang macet > BATAS_TUGAS_MS
// dilepas dari antrean supaya chat itu tidak terkunci selamanya.
const BATAS_TUGAS_MS = 5 * 60 * 1000;
const antreanPerChat = new Map();

function jalankanBerurutan(kunci, tugas) {
  const sebelumnya = antreanPerChat.get(kunci) || Promise.resolve();
  const berikutnya = sebelumnya.then(
    () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.error(`⏱️  Tugas chat ${kunci} melebihi ${BATAS_TUGAS_MS / 1000}s, dilepas dari antrean.`);
          resolve();
        }, BATAS_TUGAS_MS);
        Promise.resolve()
          .then(tugas)
          .catch((err) => console.error(`❌ Error memproses pesan ${kunci}:`, err))
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      })
  );
  antreanPerChat.set(kunci, berikutnya);
  berikutnya.then(() => {
    if (antreanPerChat.get(kunci) === berikutnya) antreanPerChat.delete(kunci);
  });
}

// Jalankan fn untuk tiap jid; kegagalan satu user dicatat, tidak membatalkan user lainnya.
async function untukSetiapJid(label, daftarJid, fn) {
  for (const jid of daftarJid) {
    try {
      await fn(jid);
    } catch (err) {
      console.error(`❌ ${label} gagal untuk ${jid}:`, err.message);
    }
  }
}

// Pembungkus cron: error di dalam satu eksekusi dicatat, tidak jadi unhandled rejection.
function jadwalkan(ekspresi, fn) {
  return cron.schedule(ekspresi, async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`❌ Error di jadwal cron "${ekspresi}":`, err);
    }
  });
}

// Indikator "sedang mengetik" selama agent bekerja. Gagal pun tidak masalah.
function tandaiMengetik(jid) {
  try {
    Promise.resolve(sock.sendPresenceUpdate('composing', jid)).catch(() => {});
  } catch {
    /* abaikan */
  }
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
  const contextInfo = bukaPembungkusPesan(message.message)?.extendedTextMessage?.contextInfo;
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
  // Perintah operator (/power ..., /feedback ...) ditangani sebelum cek registrasi, supaya operator
  // tidak perlu onboarding dulu. Dari nomor lain, "/power" diperlakukan sebagai pesan biasa.
  if (power.isOperator(jid) && power.adalahPerintahOperator(textAsli)) {
    const balasan = await power.tanganiPerintahOperator(textAsli, jid, depsPower);
    for (const bagian of power.pecahPesan(balasan)) await kirimPesan(jid, bagian);
    return;
  }

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

  // State dari alur tanya-jawab lama (sebelum agent) tidak lagi dipakai oleh fitur apa pun: lepas
  // dan serahkan pesannya ke agent, supaya user tidak terjebak di jalur lama.
  if (['WAITING_LANJUT_SESI', 'WAITING_CONFIRM', 'WAITING_CONFIRM_TERJEMAH'].includes(state)) {
    setUserState(jid, 'IDLE');
    user.state = 'IDLE';
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

  // Konteks "baru ditanya kenapa belum sempat baca" berlaku untuk SATU balasan saja; setelah itu
  // dilepas (dulu menggantung dan terus dimasukkan ke prompt di setiap pesan berikutnya).
  const systemPrompt = buatPromptPersonal(user, { powerUser: power.isPowerUser(jid) });
  if (state === 'WAITING_ALASAN_TIDAK_BACA') setUserState(jid, 'IDLE');

  tandaiMengetik(jid);
  const hasil = await jalankanAgentDawam({
    systemPrompt,
    tools: toolsPersonalUntuk(jid),
    historiChat: getChatHistory(jid, 12),
    pesanBaru: textAsli,
    eksekutorTools: EKSEKUTOR_PERSONAL,
    konteks,
  });

  if (hasil.error || !hasil.jawabanFinal) {
    console.log(`⚠️  Agent gagal/kosong untuk ${jid}: ${hasil.error}`);
    await sock.sendMessage(jid, { text: PESAN_AGENT_GANGGUAN });
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
            updateLastSentBacaanId(jid, bacaanDitemukan.urutan - 1);
            setStartBacaanId(jid, bacaanDitemukan.urutan - 1); // titik berangkat, buat hitung pace dari sini
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
      mulai_surat: PESAN_TANYA_MULAI_SURAT,
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




// ========== LOGIC PENGIRIMAN BACAAN -- SELALU PERSONAL (§4) ==========
// PENTING: fungsi-fungsi ini HANYA pernah dipanggil dengan jid personal (@s.whatsapp.net),
// TIDAK PERNAH dengan jid grup. Bacaan tidak pernah dikirim ke grup.



// ========== FUNGSI UNTUK AGENT (dipanggil tools.js lewat konteks) ==========
// Sengaja independen dari kirimBacaanArab/kirimBacaanTerjemahSaja di atas
// (yang masih dipakai flow state lama) supaya tidak saling pengaruh selama migrasi bertahap.
// Akan di-cleanup/di-dedup di Step 10 setelah flow lama resmi dibuang.

async function kirimGambarBacaanMentah(jid, bacaan, jenis) {
  const relPath = jenis === 'arab' ? pathArabDariKode(bacaan.kode) : pathIndoDariKode(bacaan.kode);
  const caption = jenis === 'arab'
    ? CAPTION_KARTU_ARAB(bacaan.surat_ayat)
    : CAPTION_KARTU_TERJEMAH(bacaan.surat_ayat);
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

// Jumlah kartu dikirim sekaligus per panggilan kirim_bacaan_lanjutan, sesuai kecepatan
// target user -- user yang targetnya cepat (butuh banyak bacaan/hari) dikirim
// beberapa kartu sekaligus biar tidak keseringan harus minta "lanjut" manual satu-satu.
function tentukanJumlahKartuPerKirim(targetJuzPerHari) {
  const peta = { '12': 1, '6': 2, '3': 3, '1': 6 };
  return peta[targetJuzPerHari] || 1; // default 1 kalau belum ada target/tidak dikenali
}

function buatCatatanSetelahKirimBacaan(modeArabSaja, statusPace, target, selisihTampilan, suratAyat, namaUser) {
  const sapa = namaUser || 'Sahabat';

  const bagianDasar = `Bacaan "${suratAyat}" sudah terkirim ke ${sapa}. Sebutkan ini di awal balasanmu dengan singkat dan natural (contoh gaya: "${suratAyat} udah terkirim, ${sapa}."), JANGAN pakai kalimat "Barakallahu fiik" atau sejenisnya lagi di sini (itu sudah terkirim terpisah sebelum kartu). PENTING: field selisihTampilan di bawah ini SUDAH khusus progress HARI INI SAJA (bukan total keseluruhan) -- JANGAN sebutkan angka progress total/keseluruhan apapun di sini, walau kamu tahu dari percakapan sebelumnya, karena itu akan membingungkan dan tidak relevan dengan konteks target harian ini.`;

  const bagianMode = modeArabSaja
    ? ' Setelah itu, tawarkan dengan natural apakah mau sekalian dikirim terjemahnya juga (tool kirim_terjemah_bacaan), ATAU langsung lanjut ke kartu berikutnya (tool kirim_bacaan_lanjutan) -- sebut dua opsi ini sebagai pertanyaan singkat di akhir, jangan pisah jadi dua pertanyaan.'
    : ' User sedang mode halangan (terjemah-saja).';

  let bagianPace = '';
  if (statusPace === 'DI_BAWAH_PACE') {
    bagianPace = ` User punya target cepat (1 juz per ${target} hari) dan statusnya "${selisihTampilan}" dari target hari ini (field ini SUDAH termasuk kata "kurang"/"lebih" di depannya, jangan ditambah kata "kurang" lagi). WAJIB sebutkan angka ini APA ADANYA secara konkret di tengah kalimat (contoh gaya: "tinggal ${selisihTampilan} lagi buat nutup target hari ini, dikit banget!"), jangan dikonversi ulang/dihitung ulang, lalu beri semangat singkat.`;
  } else if (statusPace === 'SUDAH_CAPAI_PACE') {
    bagianPace = ` User SUDAH mencapai 100% target pace hari ini (1 juz per ${target} hari), malah ${selisihTampilan} dari target. WAJIB sebutkan eksplisit bahwa target hari ini sudah tercapai/100% (jangan cuma tersirat) dan beri apresiasi hangat.`;
  }

  return bagianDasar + bagianMode + bagianPace;
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
    setSudahLaporSesiIni(jid, true);
    console.log(`✅ [Agent] Reminder-saja terkirim ke ${jid} (mode bentuk_bacaan='reminder').`);
    return {
      sukses: true,
      mode: 'reminder_saja',
      catatan_untuk_ai: 'User sedang mode reminder-saja (tanpa kartu gambar), jadi posisi TIDAK otomatis bertambah. Kalau user lapor progress manual, cukup tanggapi natural tanpa tool set_posisi_bacaan.',
    };
  }

  const urutanMin = getUrutanMin();
  const urutanMax = getUrutanMax();
  const modeArabSaja = user.mode_baca_arab_saja === 1;
  const jenisDikirim = modeArabSaja ? 'arab' : 'indo';
  const jumlahKartuPerKirim = tentukanJumlahKartuPerKirim(user.target_juz_per_hari);

  let urutanSekarang = user.last_sent_bacaan_id || 0;
  let startBacaanId = user.start_bacaan_id || 0;
  const hariIniISO = tanggalHariIniISO();

  let barusanKhatamSekaliSaja = false;
  let bacaanTerakhirTerkirim = null;
  let jumlahBerhasilTerkirim = 0;

  for (let i = 0; i < jumlahKartuPerKirim; i++) {
    const urutanSebelumWrap = urutanSekarang + 1;
    let nextUrutan = urutanSebelumWrap;
    if (nextUrutan > urutanMax) nextUrutan = urutanMin;

    const bacaan = getBacaanByUrutan(nextUrutan);
    if (!bacaan) {
      console.log(`⚠️  Bacaan urutan=${nextUrutan} tidak ditemukan (agent), berhenti di tengah batch.`);
      break; // data habis/belum lengkap, hentikan batch tapi tetap lanjut proses yang sudah terkirim
    }

    const terkirim = await kirimGambarBacaanMentah(jid, bacaan, jenisDikirim);
    if (!terkirim) {
      console.log(`⚠️  Gagal kirim 1 kartu di tengah batch (urutan=${nextUrutan}), berhenti di sini.`);
      break;
    }

    // Khatam: (1) satu putaran penuh dari titik start user (berlaku untuk start di mana pun),
    // atau (2) aturan lama berbasis wrap (menjaga user yang sedang tepat di kartu terakhir).
    const khatamPutaranPenuh = sudahKhatamSetelahKirim(startBacaanId, urutanSekarang, nextUrutan);
    const khatamWrapLama = sudahKhatamSetelahWrap(startBacaanId, urutanSebelumWrap, nextUrutan);
    if (khatamPutaranPenuh || khatamWrapLama) {
      startBacaanId = khatamPutaranPenuh ? nextUrutan : (nextUrutan - 1 < urutanMin ? urutanMax : nextUrutan - 1);
      setStartBacaanId(jid, startBacaanId);
      barusanKhatamSekaliSaja = true;
    }

    updateLastSentBacaanId(jid, nextUrutan);
    catatLogBacaanHarian(jid, hariIniISO, nextUrutan, bacaan.surat_ayat, null); // status final dihitung di akhir batch

    urutanSekarang = nextUrutan;
    bacaanTerakhirTerkirim = bacaan;
    jumlahBerhasilTerkirim++;

    // Jeda kecil antar kartu biar tidak kelihatan spam/kebanjiran sekaligus di WA.
    if (i < jumlahKartuPerKirim - 1) await tunggu(700);
  }

  if (jumlahBerhasilTerkirim === 0) {
    return { sukses: false, pesan: 'Gagal mengirim gambar bacaan.' };
  }

  if (!user.tanggal_mulai_baca) {
    setTanggalMulaiBaca(jid, hariIniISO);
  }
  setTanggalTerakhirBaca(jid, hariIniISO);
  resetNoResponse(jid);
  setSudahLaporSesiIni(jid, true);

  // Status pace dihitung SEKALI di akhir batch (bukan tiap kartu), berdasarkan akumulasi
  // total hari ini -- lebih akurat daripada status per-kartu yang bisa berubah2 di tengah.
  const { status: statusPace, selisihTampilan } = hitungStatusPaceUntukAgent(jid);
  console.log(`✅ [Agent] ${jumlahBerhasilTerkirim} kartu ${jenisDikirim} terkirim ke ${jid}, terakhir: ${bacaanTerakhirTerkirim.surat_ayat}`);

  const catatanJumlahKartu = jumlahBerhasilTerkirim > 1
    ? ` (total ${jumlahBerhasilTerkirim} kartu baru saja dikirim sekaligus sesuai temponya, bukan cuma 1 -- boleh disebutkan sekilas kalau pas, tapi tidak wajib didetailkan satu-satu.)`
    : '';

  return {
    sukses: true,
    surat_ayat: bacaanTerakhirTerkirim.surat_ayat,
    juz: bacaanTerakhirTerkirim.juz,
    jenis_dikirim: jenisDikirim,
    jumlah_kartu_terkirim: jumlahBerhasilTerkirim,
    barusan_khatam: barusanKhatamSekaliSaja,
    catatan_untuk_ai: (barusanKhatamSekaliSaja
      ? `User BARU SAJA KHATAM! Muter penuh dari titik mulainya dan sekarang kembali ke sana. Ucapkan selamat/apresiasi besar atas pencapaian khatamnya dengan hangat, sebelum lanjut ke catatan progress biasa berikut: ${buatCatatanSetelahKirimBacaan(modeArabSaja, statusPace, user.target_juz_per_hari, selisihTampilan, bacaanTerakhirTerkirim.surat_ayat, user.name)}`
      : buatCatatanSetelahKirimBacaan(modeArabSaja, statusPace, user.target_juz_per_hari, selisihTampilan, bacaanTerakhirTerkirim.surat_ayat, user.name)
    ) + catatanJumlahKartu,
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
  setSudahLaporSesiIni(jid, true);

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



// ========== §7: COUNTER TIDAK BACA + PESAN MOTIVASI ==========


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

  jadwalkan(INTERVAL_CRON_SILENT, async () => {
    console.log('\n🔍 Menjalankan pengecekan silent user...');
    const ambangMs = AMBANG_SILENT_JAM * 60 * 60 * 1000;
    const sekarang = Date.now();

    const silentUsers = getAllUsers().filter((u) => {
      // User yang sudah berhenti / belum terdaftar tidak lagi ditawari apa pun, jadi tidak
      // boleh dianggap "silent" (kalau tidak, pesan "3x tidak baca" terus terkirim ke mereka).
      if (u.is_registered !== 1 || u.is_active !== 1 || u.state === 'ONBOARDING') return false;
      if (!u.waktu_tawaran_terakhir) return false;
      if (u.sudah_lapor_sesi_ini === 1) return false; // sudah ada aktivitas sejak ditawari, bukan silent
      const waktuTawaran = new Date(u.waktu_tawaran_terakhir).getTime();
      return sekarang - waktuTawaran > ambangMs;
    });

    await untukSetiapJid('Cek silent', silentUsers.map((u) => u.jid), async (jid) => {
      incrementNoResponse(jid);
      console.log(`⏳ User ${jid} dianggap silent, counter naik.`);

      const userTerbaru = getUser(jid);
      if (userTerbaru.consecutive_no_response >= 3) {
        await kirimPesanSetelah3xTidakBaca(jid);
      }
    });

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
  if (user.state === 'ONBOARDING') {
    console.log(`(User ${jid} masih onboarding, reminder dilewati.)`);
    return;
  }
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
  setTimeout(() => {
    kirimTawaranNgaji(jid).catch((err) => console.error(`❌ Gagal kirim tawaran ngaji ke ${jid}:`, err.message));
  }, JEDA_TAWARAN_MS);
}

async function kirimTawaranNgaji(jid) {
  const user = getUser(jid);
  // Tawaran dijadwalkan 10 menit setelah reminder; kalau sejak itu user berhenti/masih onboarding, lewati.
  if (user.is_active === 0 || user.state === 'ONBOARDING') return;
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
  setSudahLaporSesiIni(jid, false);
  setWaktuTawaranTerakhir(jid, new Date().toISOString());
  console.log(`✅ Tawaran ngaji terkirim ke ${jid}, menunggu balasan (via agent)...`);
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

  jadwalkan(cronExpr, async () => {
    console.log('\n🕌 Mengirim reminder Jumat (laki-laki)...');
    const targets = getAllUsers().filter(
      (u) => u.is_registered === 1 && u.is_active === 1 && u.state !== 'ONBOARDING' && u.gender === 'L' && u.reminder_jumat_laki_aktif !== 0
    ); // <-- tambahan filter reminder_jumat_laki_aktif
    if (targets.length === 0) {
      console.log('⚠️  Tidak ada user laki-laki teraktivasi, reminder Jumat dilewati.');
      return;
    }
    await untukSetiapJid('Reminder Jumat', targets.map((u) => u.jid), kirimReminderJumatLaki);
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

  tandaiMengetik(groupJid);
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
    await sock.sendMessage(groupJid, { text: PESAN_AGENT_GANGGUAN });
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
  const tanggalSelesai = tanggalHariIniISO();
  const tanggalMulaiISO = tanggalMundurISO(6);

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
    // Laporan manual tidak punya label surat/ayat: pakai log terakhir yang berlabel; kalau tidak
    // ada, tulis jujur (dulu tampil "null").
    const logBerlabel = [...logMingguIni].reverse().find((l) => l.surat_ayat_akhir);
    const posisiAkhir = logBerlabel
      ? logBerlabel.surat_ayat_akhir
      : logMingguIni.length > 0
        ? 'laporan manual (tanpa posisi)'
        : 'belum ada bacaan minggu ini';

    // Rata-rata capaian target harian 7 hari dari data log nyata (hari kosong = 0%). Kalau user tanpa
    // target/belum mulai baca -> null ("-"), BUKAN 0%. (Versi lama bergantung status_pace_akhir yang tak
    // pernah terisi, sehingga angkanya sebenarnya persen HARI INI.)
    const persenMingguan = sisa.ada_target ? hitungPersenMingguan(jid, tanggalMulaiISO, tanggalSelesai) : null;

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

  jadwalkan(INTERVAL_CRON_MOTIVASI_GROUP, async () => {
    console.log('\n📅 Mengirim rekap mingguan ke grup aktif...');
    const grupAktif = getAllGroupsAktif();

    if (grupAktif.length === 0) {
      console.log('(Tidak ada grup aktif saat ini)');
      return;
    }

    await untukSetiapJid('Rekap mingguan', grupAktif.map((g) => g.jid), async (groupJid) => {
      const teksRekap = formatRekapMingguanTerstruktur(groupJid);
      if (!teksRekap) {
        console.log(`(Grup ${groupJid}: belum ada anggota aktivasi, rekap mingguan dilewati.)`);
        return;
      }

      let kalimatPenutup = await groqAI.generateKalimatMotivasiRekapHarian(false);
      const pesanFinal = kalimatPenutup ? `${teksRekap}\n\n${kalimatPenutup}` : teksRekap;

      await sock.sendMessage(groupJid, { text: pesanFinal });
      setGroupWaktuMotivasiTerakhir(groupJid, new Date().toISOString());
      console.log(`✅ Rekap mingguan terkirim ke grup ${groupJid}`);
    });
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
    // Belum ada target harian yang terhitung (target belum diset / belum pernah mulai baca):
    // persennya memang tidak bisa dihitung, JANGAN dipaksa tampil "0%" karena menyesatkan.
    if (d.halaman_target_hari_ini === null || d.halaman_target_hari_ini === undefined) {
      teks += d.sudah_baca_hari_ini
        ? `✅ *${d.nama}* — sudah baca hari ini (target harian belum terhitung)\n\n`
        : `💤 *${d.nama}* — belum mulai tilawah (target harian belum terhitung)\n\n`;
      continue;
    }

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

  jadwalkan(INTERVAL_CRON_LELANG_ISYA, async () => {
    console.log('\n🔔 Mengirim tawaran lelang Isya ke grup aktif...');
    const grupAktif = getAllGroupsAktif();

    if (grupAktif.length === 0) {
      console.log('(Tidak ada grup aktif saat ini)');
      return;
    }

    await untukSetiapJid('Lelang Isya', grupAktif.map((g) => g.jid), kirimTawaranLelangKeGrup);
  });

  console.log(`🕒 Lelang Isya scheduler diset (${INTERVAL_CRON_LELANG_ISYA}).`);
}

function setupRekapHarianScheduler() {
  if (rekapHarianSchedulerSudahDiset) return;
  rekapHarianSchedulerSudahDiset = true;

  jadwalkan(INTERVAL_CRON_REKAP_HARIAN, async () => {
    console.log('\n📊 Mengirim rekap harian ke grup aktif...');
    const grupAktif = getAllGroupsAktif();

    if (grupAktif.length === 0) {
      console.log('(Tidak ada grup aktif saat ini)');
      return;
    }

    await untukSetiapJid('Rekap harian', grupAktif.map((g) => g.jid), (groupJid) =>
      kirimRekapHarianKeGrup(groupJid, false, true)
    );
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
// (db di atas = koneksi SQLite mentah yang di-import dari ./db; sebelumnya tidak di-import
// sehingga membalas "ya" ke tawaran Al-Kahfi memicu ReferenceError.)
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
  setTanggalTerakhirAlkahfi(jid, tanggalHariIniISO());
  console.log(`✅ Card Al-Kahfi terkirim ke ${jid}: ${bacaan.surat_ayat} (kode=${bacaan.kode}, urutan=${nextUrutan})`);
  return { sukses: true, surat_ayat: bacaan.surat_ayat };
}

let alkahfiJumatSchedulerSudahDiset = false;

function setupAlkahfiJumatScheduler() {
  if (alkahfiJumatSchedulerSudahDiset) return;
  alkahfiJumatSchedulerSudahDiset = true;

  jadwalkan(INTERVAL_CRON_ALKAHFI_JUMAT, async () => {
    console.log('\n📖 Mengirim tawaran Al-Kahfi Jumat...');
    const targets = getRegisteredTargets();
    if (targets.length === 0) {
      console.log('⚠️  Belum ada user teraktivasi, tawaran Al-Kahfi dilewati.');
      return;
    }
    await untukSetiapJid('Tawaran Al-Kahfi', targets, async (jid) => {
      const user = getUser(jid);
      if (user.tawaran_alkahfi_aktif === 0) return;
      await kirimTawaranAlkahfi(jid);
    });
  });

  console.log(`🕒 Scheduler Al-Kahfi Jumat diset (${INTERVAL_CRON_ALKAHFI_JUMAT}).`);
}

// ========== DIGEST FEEDBACK POWER USER KE OPERATOR ==========

// Dipakai power.js untuk kirim digest & kabar "feedback selesai" (tanpa power.js pegang socket).
const depsPower = {
  kirim: (jid, text) => sock.sendMessage(jid, { text }),
};

let digestSchedulerSudahDiset = false;

function setupFeedbackDigestScheduler() {
  if (digestSchedulerSudahDiset) return;
  digestSchedulerSudahDiset = true;

  if (!power.operatorJid()) {
    console.log('⚠️  OPERATOR_NUMBER belum diset/valid di .env, digest feedback power user tidak dijadwalkan.');
    return;
  }

  // Kalau pengiriman gagal (mis. koneksi WA baru putus), coba SEKALI lagi 10 menit kemudian.
  // Feedback tidak hilang: baru ditandai terkirim setelah berhasil.
  const jalankanDigest = async () => {
    const r = await power.kirimDigest(depsPower);
    if (r.status === 'GAGAL') {
      const ulang = setTimeout(() => {
        power.kirimDigest(depsPower).catch((err) => console.error('❌ Ulang digest feedback gagal:', err));
      }, 10 * 60 * 1000);
      ulang.unref?.();
    }
  };

  let ekspresi = process.env.FEEDBACK_DIGEST_CRON || power.CRON_DIGEST_DEFAULT;
  try {
    jadwalkan(ekspresi, jalankanDigest);
  } catch (err) {
    console.error(`❌ FEEDBACK_DIGEST_CRON "${ekspresi}" tidak valid (${err.message}), pakai ${power.CRON_DIGEST_DEFAULT}.`);
    ekspresi = power.CRON_DIGEST_DEFAULT;
    jadwalkan(ekspresi, jalankanDigest);
  }
  console.log(`🕒 Scheduler digest feedback power user diset (${ekspresi}).`);

  // Bot mati/restart tepat di jam kirim: susul begitu hidup lagi (jeda sebentar biar koneksi stabil).
  const timer = setTimeout(() => {
    power.susulDigestJikaTerlewat(depsPower, ekspresi).catch((err) => console.error('❌ Susul digest feedback gagal:', err));
  }, 10_000);
  timer.unref?.();
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

    jadwalkan(cronExpr, async () => {
      console.log(`\n⏰ Waktu ${namaWaktu} tiba (${jadwal.jam}:${String(jadwal.menit).padStart(2, '0')}). Mengirim reminder otomatis...`);
      const targets = getRegisteredTargets();
      if (targets.length === 0) {
        console.log('⚠️  Belum ada user yang teraktivasi, reminder dilewati.');
        return;
      }
      await untukSetiapJid(`Reminder ${namaWaktu}`, targets, (jid) => kirimReminderSholat(namaWaktu, jid));
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
    await untukSetiapJid(`Reminder ${input}`, targets, (jid) => kirimReminderSholat(input, jid));
  } else if (input === 'help') {
    printHelp();
  } else if (input) {
    console.log(`Command "${input}" tidak dikenali. Ketik "help" untuk lihat daftar command.`);
  }
});

startBot().catch((err) => {
  console.error('❌ Gagal menjalankan bot, keluar supaya di-restart pm2:', err);
  process.exit(1);
});