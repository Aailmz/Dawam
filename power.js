// Fitur Power User: user tertentu memberi feedback ke Dawam (lewat agent), disimpan di DB, lalu
// dirangkum jadi satu digest ke SATU nomor operator tiap malam. Pengembangannya urusan manusia;
// operator cukup bilang feedback nomor berapa yang sudah selesai, lalu Dawam mengabari pengirimnya.
//
// Modul ini sengaja tidak memegang socket WhatsApp: fungsi yang mengirim pesan menerima
// deps = { kirim: async (jid, teks) => void, rapikan?: async (daftar) => ({ [id]: teks }) }.
const db = require('./db');

const BATAS_FEEDBACK_PER_HARI = 10;
const BATAS_PANJANG_FEEDBACK = 1000;
const BATAS_PANJANG_PESAN = 3500; // di atas ini digest dipecah jadi beberapa pesan
const CRON_DIGEST_DEFAULT = '0 21 * * *'; // 21:00 WIB (TZ dipasang di index.js)

// ========== IDENTITAS: OPERATOR & POWER USER ==========

// '0812-3456-789' / '+62 812...' / '62812...' -> '62812...@s.whatsapp.net'; tidak valid -> null.
function normalisasiNomor(input) {
  let digit = String(input ?? '').replace(/\D/g, '');
  if (digit.startsWith('0')) digit = `62${digit.slice(1)}`;
  else if (digit.startsWith('8')) digit = `62${digit}`;
  if (!/^62\d{8,13}$/.test(digit)) return null;
  return `${digit}@s.whatsapp.net`;
}

// Dibaca tiap dipanggil (bukan sekali saat load) supaya perubahan env di test/dev langsung berlaku.
function operatorJid() {
  return process.env.OPERATOR_NUMBER ? normalisasiNomor(process.env.OPERATOR_NUMBER) : null;
}

function digitDariJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isOperator(jid) {
  const op = operatorJid();
  return !!op && !!jid && digitDariJid(jid) === digitDariJid(op);
}

// Operator otomatis power user.
function isPowerUser(jid) {
  return !!jid && (isOperator(jid) || db.isPowerUserDb(jid));
}

function tampilNomor(jid) {
  return `+${digitDariJid(jid)}`;
}

function namaTampil(f) {
  return f.nama || tampilNomor(f.user_jid);
}

function potong(teks, maks) {
  const t = String(teks || '').replace(/\s+/g, ' ').trim();
  return t.length > maks ? `${t.slice(0, maks - 1)}…` : t;
}

// ========== PARSE DAFTAR NOMOR FEEDBACK ==========

const POLA_RENTANG = /^\s*(\d+)(?:\s*(?:-|–|sampai|hingga|s\/d|sd)\s*(\d+))?\s*(,)?/i;

// "12-15", "3,5,8-9", "12 sampai 15" di AWAL teks. Sisanya dikembalikan sebagai `sisa` (catatan).
// Mengembalikan { ids: number[] (unik, urut), sisa } atau null kalau tidak ada nomor sama sekali.
function parseDaftarId(teks) {
  let sisa = String(teks || '');
  const ids = new Set();
  let ada = false;
  for (let i = 0; i < 50; i++) {
    const m = sisa.match(POLA_RENTANG);
    if (!m) break;
    const awal = Number(m[1]);
    const akhir = m[2] !== undefined ? Number(m[2]) : awal;
    if (akhir < awal || akhir - awal > 500) return null; // rentang kebalik / tidak masuk akal
    for (let n = awal; n <= akhir; n++) ids.add(n);
    ada = true;
    sisa = sisa.slice(m[0].length);
    if (!m[3]) break; // tidak ada koma = daftar selesai, sisanya catatan
  }
  if (!ada) return null;
  return { ids: [...ids].sort((a, b) => a - b), sisa: sisa.trim() };
}

function ringkasIds(ids) {
  return ids.map((i) => `#${i}`).join(', ');
}

// ========== DIGEST KE OPERATOR ==========

const URUTAN_KATEGORI = [
  ['BUG', '🐞 *Bug*'],
  ['SARAN', '💡 *Saran fitur*'],
  ['KELUHAN', '😕 *Keluhan*'],
  ['LAIN', '📝 *Lain-lain*'],
];

function formatTanggalPanjang(date = new Date()) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

// items: baris feedback_power + { nama }; teks yang ditampilkan = isi_rapi, fallback isi_asli.
function susunDigest(items, date = new Date()) {
  const baris = [
    '📋 *Feedback Power User Dawam*',
    `${formatTanggalPanjang(date)} · ${items.length} feedback`,
  ];
  for (const [kode, judul] of URUTAN_KATEGORI) {
    const grup = items.filter((f) => (URUTAN_KATEGORI.some(([k]) => k === f.kategori) ? f.kategori : 'LAIN') === kode);
    if (grup.length === 0) continue;
    baris.push('', `${judul} (${grup.length})`);
    for (const f of grup) {
      baris.push(`• #${f.id} ${namaTampil(f)} (${tampilNomor(f.user_jid)}): ${f.isi_rapi || f.isi_asli}`);
    }
  }
  const idPertama = items[0].id;
  const idTerakhir = items[items.length - 1].id;
  const contoh = idPertama === idTerakhir ? `${idPertama}` : `${idPertama}-${idTerakhir}`;
  baris.push('', `Kalau sudah dikerjakan, balas: /feedback selesai ${contoh}`);
  return baris.join('\n');
}

// Pecah pesan panjang per baris supaya tiap pesan WhatsApp tetap nyaman dibaca.
function pecahPesan(teks, maks = BATAS_PANJANG_PESAN) {
  const hasil = [];
  let cur = '';
  for (const baris of teks.split('\n')) {
    const calon = cur ? `${cur}\n${baris}` : baris;
    if (calon.length > maks && cur) {
      hasil.push(cur);
      cur = baris;
    } else {
      cur = calon;
    }
  }
  if (cur) hasil.push(cur);
  return hasil;
}

let digestSedangJalan = false;

// Kumpulkan feedback PENDING, rapikan, kirim ke operator. Baru ditandai TERKIRIM SETELAH semua
// pesan berhasil terkirim, jadi kalau gagal tidak ada feedback yang hilang (dicoba lagi nanti).
// status: TERKIRIM | KOSONG | GAGAL | SEDANG_BERJALAN | TANPA_OPERATOR
async function kirimDigest(deps) {
  const op = operatorJid();
  if (!op) return { status: 'TANPA_OPERATOR', jumlah: 0 };
  if (digestSedangJalan) return { status: 'SEDANG_BERJALAN', jumlah: 0 };
  digestSedangJalan = true;
  try {
    const pending = db.getFeedbackPowerPending();
    if (pending.length === 0) return { status: 'KOSONG', jumlah: 0 };

    let rapi = {};
    try {
      const rapikan = deps.rapikan || require('./groq').rapikanFeedbackUntukOperator;
      rapi = (await rapikan(pending)) || {};
    } catch (err) {
      console.error('❌ Merapikan feedback gagal, pakai kalimat asli:', err.message);
    }
    for (const f of pending) {
      if (rapi[f.id]) {
        f.isi_rapi = rapi[f.id];
        db.simpanIsiRapiFeedback(f.id, rapi[f.id]);
      }
    }

    try {
      for (const bagian of pecahPesan(susunDigest(pending))) await deps.kirim(op, bagian);
    } catch (err) {
      console.error('❌ Gagal mengirim digest feedback ke operator:', err.message);
      return { status: 'GAGAL', jumlah: pending.length };
    }

    db.tandaiFeedbackTerkirim(pending.map((f) => f.id));
    db.catatDigestTerkirim(pending.length);
    console.log(`✅ Digest feedback power user terkirim ke operator (${pending.length} feedback).`);
    return { status: 'TERKIRIM', jumlah: pending.length };
  } finally {
    digestSedangJalan = false;
  }
}

// Ambil jam:menit dari ekspresi cron sederhana "M H * * *"; selain itu null (tidak bisa disusul).
function jamDariCron(ekspresi) {
  const m = String(ekspresi || '').trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 23) return null;
  return { menit: Number(m[1]), jam: Number(m[2]) };
}

function menitSekarangWIB(date = new Date()) {
  const bagian = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const jam = Number(bagian.find((p) => p.type === 'hour').value);
  const menit = Number(bagian.find((p) => p.type === 'minute').value);
  return jam * 60 + menit;
}

// Dipanggil saat bot (re)start: kalau jam kirim hari ini sudah lewat dan digest hari ini belum
// terkirim padahal ada feedback menunggu, kirim sekarang. Sisa hari lewat tengah malam otomatis
// ditangani jadwal 21:00 berikutnya (feedback tetap PENDING).
async function susulDigestJikaTerlewat(deps, ekspresiCron, date = new Date()) {
  const jadwal = jamDariCron(ekspresiCron);
  if (!jadwal || !operatorJid()) return null;
  if (menitSekarangWIB(date) < jadwal.jam * 60 + jadwal.menit) return null;
  if (db.sudahKirimDigestHariIni()) return null;
  if (db.getFeedbackPowerPending().length === 0) return null;
  console.log('⏰ Digest feedback hari ini belum terkirim (bot sempat mati?), menyusul sekarang.');
  return kirimDigest(deps);
}

// ========== FEEDBACK SELESAI -> KABARI PENGIRIM ==========

function pesanSelesaiUntukUser(nama, rows, catatan) {
  const daftar = rows.map((f) => `• #${f.id}: ${potong(f.isi_asli, 160)}`).join('\n');
  const jamak = rows.length > 1 ? 'Masukan-masukan' : 'Masukan';
  return (
    `Halo ${nama || 'Sahabat Dawam'}, kabar baik! 🤍 ${jamak} kamu untuk Dawam sudah dikerjakan tim:\n\n${daftar}\n\n` +
    (catatan ? `Catatan dari tim: ${catatan}\n\n` : '') +
    'Makasih banyak ya sudah ikut bantu bikin Dawam makin baik 🙏'
  );
}

// Tandai selesai lalu kabari tiap pengirim SATU pesan (gabungan feedback-nya yang selesai).
async function selesaikanDanBeritahu(ids, catatan, deps) {
  const rows = db.selesaikanFeedbackPower(ids, catatan);
  const idBaru = new Set(rows.map((r) => r.id));
  const tidakAda = [];
  const sudahSelesai = [];
  for (const id of ids) {
    if (idBaru.has(id)) continue;
    (db.getFeedbackPower(id) ? sudahSelesai : tidakAda).push(id);
  }

  const perUser = new Map();
  for (const r of rows) {
    if (!perUser.has(r.user_jid)) perUser.set(r.user_jid, []);
    perUser.get(r.user_jid).push(r);
  }

  const diberitahu = [];
  const gagalDiberitahu = [];
  for (const [jid, daftar] of perUser) {
    try {
      await deps.kirim(jid, pesanSelesaiUntukUser(daftar[0].nama, daftar, catatan));
      db.tandaiUserDiberitahuSelesai(daftar.map((r) => r.id));
      diberitahu.push(namaTampil(daftar[0]));
    } catch (err) {
      console.error(`❌ Gagal mengabari ${jid} soal feedback selesai:`, err.message);
      gagalDiberitahu.push(namaTampil(daftar[0]));
    }
  }
  return { rows, tidakAda, sudahSelesai, diberitahu, gagalDiberitahu };
}

// ========== PERINTAH OPERATOR ==========

const TEKS_BANTUAN_OPERATOR = `*Perintah operator Dawam*

*Power user*
/power tambah 0812xxxx
/power hapus 0812xxxx
/power daftar

*Feedback*
/feedback daftar  (yang belum selesai)
/feedback kirim  (kirim digest sekarang)
/feedback selesai 12-15 [catatan]
/feedback selesai 3,5,8-9 [catatan]

Setelah "selesai", pengirimnya otomatis dikabari.`;

function adalahPerintahOperator(teks) {
  return /^\s*\/(power|feedback)\b/i.test(String(teks || ''));
}

async function perintahPower(sub, argumen, operator) {
  if (sub === 'tambah' || sub === 'hapus') {
    const jid = normalisasiNomor(argumen);
    if (!jid) return 'Nomornya belum valid. Contoh: /power tambah 081234567890';
    if (sub === 'tambah') {
      if (isOperator(jid)) return 'Nomor itu operator, sudah otomatis power user.';
      return db.tambahPowerUser(jid, operator)
        ? `✅ ${tampilNomor(jid)} sekarang power user. Kabari orangnya ya, Dawam tidak mengirim pemberitahuan sendiri.`
        : `${tampilNomor(jid)} sudah power user sebelumnya.`;
    }
    if (isOperator(jid)) return 'Operator selalu power user, tidak bisa dihapus.';
    return db.hapusPowerUser(jid)
      ? `✅ ${tampilNomor(jid)} bukan power user lagi.`
      : `${tampilNomor(jid)} memang bukan power user.`;
  }
  if (sub === 'daftar') {
    const daftar = db.getAllPowerUsers();
    const baris = [`• ${tampilNomor(operatorJid())} (operator)`];
    for (const p of daftar) baris.push(`• ${tampilNomor(p.jid)}${p.name ? ` (${p.name})` : ''}`);
    return `*Power user* (${baris.length})\n${baris.join('\n')}`;
  }
  return TEKS_BANTUAN_OPERATOR;
}

async function perintahFeedback(sub, argumen, deps) {
  if (sub === 'daftar') {
    const belum = db.getFeedbackPowerBelumSelesai();
    if (belum.length === 0) return 'Tidak ada feedback yang belum selesai 🎉';
    const baris = belum.map(
      (f) =>
        `• #${f.id} [${f.kategori}] ${namaTampil(f)}: ${potong(f.isi_rapi || f.isi_asli, 140)}${f.status === 'PENDING' ? ' (belum masuk digest)' : ''}`
    );
    return `*Feedback belum selesai* (${belum.length})\n${baris.join('\n')}`; // index.js memecah kalau panjang
  }

  if (sub === 'kirim') {
    const r = await kirimDigest(deps);
    if (r.status === 'KOSONG') return 'Tidak ada feedback baru untuk dikirim.';
    if (r.status === 'SEDANG_BERJALAN') return 'Digest sedang dikirim, tunggu sebentar.';
    if (r.status === 'GAGAL') return '⚠️ Digest gagal dikirim, feedback tetap aman dan akan dicoba lagi.';
    if (r.status === 'TANPA_OPERATOR') return 'OPERATOR_NUMBER belum diset.';
    return `✅ Digest terkirim (${r.jumlah} feedback).`;
  }

  if (sub === 'selesai' || sub === 'done') {
    const parsed = parseDaftarId(argumen);
    if (!parsed) return 'Sebutkan nomor feedback-nya. Contoh: /feedback selesai 12-15 atau /feedback selesai 3,5,8';
    const catatan = potong(parsed.sisa, 300) || null;
    const r = await selesaikanDanBeritahu(parsed.ids, catatan, deps);
    const baris = [];
    if (r.rows.length > 0) baris.push(`✅ Selesai: ${ringkasIds(r.rows.map((x) => x.id))}`);
    if (r.diberitahu.length > 0) baris.push(`📨 Sudah dikabari: ${r.diberitahu.join(', ')}`);
    if (r.gagalDiberitahu.length > 0) baris.push(`⚠️ Gagal dikabari: ${r.gagalDiberitahu.join(', ')} (status tetap selesai)`);
    if (r.sudahSelesai.length > 0) baris.push(`Sudah selesai sebelumnya: ${ringkasIds(r.sudahSelesai)}`);
    if (r.tidakAda.length > 0) baris.push(`Tidak ditemukan: ${ringkasIds(r.tidakAda)}`);
    return baris.join('\n') || 'Tidak ada yang diubah.';
  }

  return TEKS_BANTUAN_OPERATOR;
}

// Titik masuk dari index.js. Hanya dipanggil kalau isOperator(jid) && adalahPerintahOperator(teks).
// Selalu mengembalikan teks balasan untuk operator.
async function tanganiPerintahOperator(teks, operator, deps) {
  const m = String(teks).trim().match(/^\/(power|feedback)\b\s*(\S*)\s*([\s\S]*)$/i);
  if (!m) return TEKS_BANTUAN_OPERATOR;
  const [, perintah, sub, argumen] = m;
  try {
    return perintah.toLowerCase() === 'power'
      ? await perintahPower(sub.toLowerCase(), argumen, operator)
      : await perintahFeedback(sub.toLowerCase(), argumen, deps);
  } catch (err) {
    console.error('❌ Error perintah operator:', err);
    return `⚠️ Perintah gagal diproses: ${err.message}`;
  }
}

module.exports = {
  BATAS_FEEDBACK_PER_HARI,
  BATAS_PANJANG_FEEDBACK,
  CRON_DIGEST_DEFAULT,
  normalisasiNomor,
  operatorJid,
  isOperator,
  isPowerUser,
  parseDaftarId,
  susunDigest,
  pecahPesan,
  kirimDigest,
  jamDariCron,
  susulDigestJikaTerlewat,
  selesaikanDanBeritahu,
  adalahPerintahOperator,
  tanganiPerintahOperator,
};
