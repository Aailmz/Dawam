// Tes fitur Power User (feedback -> digest operator -> kabar selesai). DB in-memory, tanpa WhatsApp/AI.
process.env.DAWAM_DB_PATH = ':memory:';
process.env.OPERATOR_NUMBER = '0811-0000-111';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const power = require('../power');
const { EKSEKUTOR_PERSONAL, TOOLS_PERSONAL, TOOLS_POWER, toolsPersonalUntuk } = require('../tools');
const { buatPromptPersonal } = require('../prompts');

const OPERATOR = '628110000111@s.whatsapp.net';
const RINA = '628100000101@s.whatsapp.net';
const BUDI = '628100000102@s.whatsapp.net';
const ORANG_BIASA = '628100000103@s.whatsapp.net';

function buatUser(jid, name) {
  db.registerUser(jid);
  db.updateUserFields(jid, { name });
}
buatUser(RINA, 'Rina');
buatUser(BUDI, 'Budi');
buatUser(ORANG_BIASA, 'Biasa');
db.tambahPowerUser(RINA, OPERATOR);
db.tambahPowerUser(BUDI, OPERATOR);

// Pengirim palsu: mencatat semua pesan, bisa dibuat gagal ke jid tertentu.
function buatDeps({ rapikan, gagalKe = [] } = {}) {
  const terkirim = [];
  return {
    terkirim,
    kirim: async (jid, teks) => {
      if (gagalKe.includes(jid)) throw new Error('gagal kirim');
      terkirim.push({ jid, teks });
    },
    rapikan: rapikan || (async (daftar) => Object.fromEntries(daftar.map((f) => [f.id, `RAPI: ${f.isi_asli}`]))),
  };
}
const panggil = (nama, args, jid) => EKSEKUTOR_PERSONAL[nama](args, { jid });
const kosongkanFeedback = () => {
  db.db.prepare('DELETE FROM feedback_power').run();
  db.db.prepare('DELETE FROM feedback_digest_log').run();
};

// ========== identitas ==========

test('normalisasiNomor: format umum diterima, sampah ditolak', () => {
  assert.equal(power.normalisasiNomor('0812-3456-7890'), '6281234567890@s.whatsapp.net');
  assert.equal(power.normalisasiNomor('+62 812 3456 7890'), '6281234567890@s.whatsapp.net');
  assert.equal(power.normalisasiNomor('81234567890'), '6281234567890@s.whatsapp.net');
  assert.equal(power.normalisasiNomor('123'), null);
  assert.equal(power.normalisasiNomor('abc'), null);
  assert.equal(power.normalisasiNomor(''), null);
  assert.equal(power.normalisasiNomor(undefined), null);
});

test('operator dikenali dari env (termasuk suffix perangkat), otomatis power user', () => {
  assert.equal(power.operatorJid(), OPERATOR);
  assert.ok(power.isOperator(OPERATOR));
  assert.ok(power.isOperator('628110000111:12@s.whatsapp.net'));
  assert.ok(!power.isOperator(RINA));
  assert.ok(power.isPowerUser(OPERATOR), 'operator otomatis power user walau tidak ada di tabel');
  assert.ok(power.isPowerUser(RINA));
  assert.ok(!power.isPowerUser(ORANG_BIASA));
  assert.ok(!power.isPowerUser(null));
});

test('tanpa OPERATOR_NUMBER: tidak ada operator, digest ditolak rapi', async () => {
  const simpan = process.env.OPERATOR_NUMBER;
  delete process.env.OPERATOR_NUMBER;
  try {
    assert.equal(power.operatorJid(), null);
    assert.ok(!power.isOperator(OPERATOR));
    assert.deepEqual(await power.kirimDigest(buatDeps()), { status: 'TANPA_OPERATOR', jumlah: 0 });
  } finally {
    process.env.OPERATOR_NUMBER = simpan;
  }
});

// ========== parse nomor feedback ==========

test('parseDaftarId: rentang, daftar, "sampai", catatan di belakang, dan input rusak', () => {
  assert.deepEqual(power.parseDaftarId('12-15'), { ids: [12, 13, 14, 15], sisa: '' });
  assert.deepEqual(power.parseDaftarId('3,5,8-9 sudah rilis'), { ids: [3, 5, 8, 9], sisa: 'sudah rilis' });
  assert.deepEqual(power.parseDaftarId('12 sampai 14'), { ids: [12, 13, 14], sisa: '' });
  assert.deepEqual(power.parseDaftarId('4 s/d 6 catatan'), { ids: [4, 5, 6], sisa: 'catatan' });
  assert.deepEqual(power.parseDaftarId('7 sudah ditambah'), { ids: [7], sisa: 'sudah ditambah' }, '"sudah" bukan "sd"');
  assert.deepEqual(power.parseDaftarId('5,5,3'), { ids: [3, 5], sisa: '' });
  assert.equal(power.parseDaftarId('15-12'), null, 'rentang terbalik');
  assert.equal(power.parseDaftarId('1-99999'), null, 'rentang tidak masuk akal');
  assert.equal(power.parseDaftarId('semua'), null);
  assert.equal(power.parseDaftarId(''), null);
});

// ========== tool feedback ==========

test('tool feedback: hanya power user; tool power hanya diberikan ke power user', async () => {
  const r = await panggil('kirim_feedback_dawam', { isi: 'tolong tambah fitur ini ya', kategori: 'SARAN' }, ORANG_BIASA);
  assert.equal(r.sukses, false);
  assert.equal(db.getFeedbackPowerPending().length, 0);

  const namaTool = (daftar) => daftar.map((t) => t.function.name);
  assert.ok(!namaTool(toolsPersonalUntuk(ORANG_BIASA)).includes('kirim_feedback_dawam'));
  assert.equal(toolsPersonalUntuk(ORANG_BIASA).length, TOOLS_PERSONAL.length);
  for (const jid of [RINA, OPERATOR]) {
    const nama = namaTool(toolsPersonalUntuk(jid));
    for (const t of namaTool(TOOLS_POWER)) assert.ok(nama.includes(t), `${jid} harus punya ${t}`);
  }
  for (const t of namaTool(TOOLS_POWER)) assert.ok(EKSEKUTOR_PERSONAL[t], `eksekutor ${t} ada`);
});

test('tool feedback: tercatat, kategori tidak valid jadi LAIN, terlalu singkat/panjang ditolak, dobel tidak dicatat ulang', async () => {
  kosongkanFeedback();
  const ok = await panggil('kirim_feedback_dawam', { isi: 'tombol lanjut baca kadang tidak merespons', kategori: 'BUG' }, RINA);
  assert.equal(ok.sukses, true);
  assert.equal(ok.kategori, 'BUG');
  assert.match(ok.catatan_untuk_ai, new RegExp(`#${ok.id}`));
  assert.equal(db.getFeedbackPower(ok.id).status, 'PENDING');

  const aneh = await panggil('kirim_feedback_dawam', { isi: 'kategori ngawur dari AI nih', kategori: 'XYZ' }, RINA);
  assert.equal(db.getFeedbackPower(aneh.id).kategori, 'LAIN');

  assert.equal((await panggil('kirim_feedback_dawam', { isi: 'pendek', kategori: 'LAIN' }, RINA)).sukses, false);
  assert.equal((await panggil('kirim_feedback_dawam', { isi: 'x'.repeat(1001), kategori: 'LAIN' }, RINA)).sukses, false);

  const dobel = await panggil('kirim_feedback_dawam', { isi: 'tombol lanjut baca kadang tidak merespons', kategori: 'BUG' }, RINA);
  assert.equal(dobel.sukses, true);
  assert.equal(dobel.sudah_ada, true);
  assert.equal(dobel.id, ok.id);
  assert.equal(db.getFeedbackPowerPending().length, 2);
});

test('tool feedback: batas harian per user', async () => {
  kosongkanFeedback();
  for (let i = 0; i < power.BATAS_FEEDBACK_PER_HARI; i++) {
    const r = await panggil('kirim_feedback_dawam', { isi: `masukan nomor ${i} yang cukup panjang`, kategori: 'SARAN' }, RINA);
    assert.equal(r.sukses, true, `ke-${i}`);
  }
  const lebih = await panggil('kirim_feedback_dawam', { isi: 'masukan ke sebelas yang ditolak', kategori: 'SARAN' }, RINA);
  assert.equal(lebih.sukses, false);
  const budi = await panggil('kirim_feedback_dawam', { isi: 'budi masih boleh kirim masukan', kategori: 'SARAN' }, BUDI);
  assert.equal(budi.sukses, true, 'batas per user, bukan global');
});

test('ubah feedback: hanya milik sendiri dan hanya selagi PENDING', async () => {
  kosongkanFeedback();
  const { id } = await panggil('kirim_feedback_dawam', { isi: 'laporan awal yang kurang lengkap', kategori: 'BUG' }, RINA);

  const orangLain = await panggil('ubah_feedback_dawam', { id, isi_baru: 'diubah orang lain, harusnya gagal' }, BUDI);
  assert.equal(orangLain.sukses, false);
  assert.equal(db.getFeedbackPower(id).isi_asli, 'laporan awal yang kurang lengkap');

  const sendiri = await panggil('ubah_feedback_dawam', { id, isi_baru: 'laporan awal, sekarang lengkap dengan detail', kategori: 'KELUHAN' }, RINA);
  assert.equal(sendiri.sukses, true);
  assert.equal(db.getFeedbackPower(id).isi_asli, 'laporan awal, sekarang lengkap dengan detail');
  assert.equal(db.getFeedbackPower(id).kategori, 'KELUHAN');

  db.tandaiFeedbackTerkirim([id]);
  const terlambat = await panggil('ubah_feedback_dawam', { id, isi_baru: 'diubah setelah masuk digest' }, RINA);
  assert.equal(terlambat.sukses, false);
  assert.match(terlambat.catatan_untuk_ai, /feedback baru/);

  const takAda = await panggil('ubah_feedback_dawam', { id: 9999, isi_baru: 'feedback yang tidak ada nomornya' }, RINA);
  assert.equal(takAda.sukses, false);
});

test('get_feedback_saya: hanya milik sendiri, status terbaca manusia', async () => {
  kosongkanFeedback();
  const a = await panggil('kirim_feedback_dawam', { isi: 'masukan milik Rina nomor satu', kategori: 'SARAN' }, RINA);
  await panggil('kirim_feedback_dawam', { isi: 'masukan milik Budi saja nih', kategori: 'SARAN' }, BUDI);
  db.tandaiFeedbackTerkirim([a.id]);

  const r = await panggil('get_feedback_saya', {}, RINA);
  assert.equal(r.jumlah, 1);
  assert.equal(r.feedback[0].id, a.id);
  assert.match(r.feedback[0].status, /diteruskan ke tim/);
  assert.equal((await panggil('get_feedback_saya', {}, ORANG_BIASA)).sukses, false);
});

test('prompt: bagian power user hanya muncul untuk power user', () => {
  const user = db.getUser(RINA);
  assert.match(buatPromptPersonal(user, { powerUser: true }), /kirim_feedback_dawam/);
  assert.doesNotMatch(buatPromptPersonal(user), /kirim_feedback_dawam/);
  assert.doesNotMatch(buatPromptPersonal(user, { powerUser: false }), /Power User Dawam/);
});

// ========== digest ==========

test('digest: dirapikan, dikelompokkan per kategori, ada nomor/nama/nomor HP, ditandai TERKIRIM, lalu tidak terkirim dua kali', async () => {
  kosongkanFeedback();
  const a = await panggil('kirim_feedback_dawam', { isi: 'kartu kadang telat datang pas subuh', kategori: 'BUG' }, RINA);
  const b = await panggil('kirim_feedback_dawam', { isi: 'tolong ada mode gelap di kartu', kategori: 'SARAN' }, BUDI);

  const deps = buatDeps();
  const r = await power.kirimDigest(deps);
  assert.deepEqual(r, { status: 'TERKIRIM', jumlah: 2 });
  assert.equal(deps.terkirim.length, 1);
  assert.equal(deps.terkirim[0].jid, OPERATOR);
  const teks = deps.terkirim[0].teks;
  assert.match(teks, /Bug/);
  assert.match(teks, /Saran fitur/);
  assert.doesNotMatch(teks, /Keluhan/, 'kategori kosong tidak ditampilkan');
  assert.match(teks, new RegExp(`#${a.id} Rina \\(\\+628100000101\\): RAPI: kartu kadang telat`));
  assert.match(teks, new RegExp(`#${b.id} Budi \\(\\+628100000102\\): RAPI: tolong ada mode gelap`));
  assert.match(teks, new RegExp(`/feedback selesai ${a.id}-${b.id}`));

  assert.equal(db.getFeedbackPower(a.id).status, 'TERKIRIM');
  assert.equal(db.getFeedbackPower(a.id).isi_rapi, 'RAPI: kartu kadang telat datang pas subuh');
  assert.equal(db.getFeedbackPower(a.id).isi_asli, 'kartu kadang telat datang pas subuh', 'kalimat asli tidak ditimpa');
  assert.ok(db.sudahKirimDigestHariIni());

  const lagi = buatDeps();
  assert.deepEqual(await power.kirimDigest(lagi), { status: 'KOSONG', jumlah: 0 });
  assert.equal(lagi.terkirim.length, 0, 'tidak ada feedback baru = tidak ada pesan');
});

test('digest: AI rapikan gagal/sebagian -> pakai kalimat asli, digest tetap terkirim', async () => {
  kosongkanFeedback();
  const a = await panggil('kirim_feedback_dawam', { isi: 'kalimat asli pertama dari user', kategori: 'LAIN' }, RINA);
  const b = await panggil('kirim_feedback_dawam', { isi: 'kalimat asli kedua dari user', kategori: 'LAIN' }, RINA);

  const sebagian = buatDeps({ rapikan: async () => ({ [a.id]: 'versi rapi pertama' }) });
  await power.kirimDigest(sebagian);
  assert.match(sebagian.terkirim[0].teks, /versi rapi pertama/);
  assert.match(sebagian.terkirim[0].teks, /kalimat asli kedua dari user/);

  const c = await panggil('kirim_feedback_dawam', { isi: 'kalimat asli ketiga dari user', kategori: 'LAIN' }, RINA);
  const error = buatDeps({ rapikan: async () => { throw new Error('API down'); } });
  assert.equal((await power.kirimDigest(error)).status, 'TERKIRIM');
  assert.match(error.terkirim[0].teks, /kalimat asli ketiga dari user/);
  assert.equal(db.getFeedbackPower(b.id).status, 'TERKIRIM');
  assert.equal(db.getFeedbackPower(c.id).status, 'TERKIRIM');
});

test('digest: gagal kirim ke operator -> feedback tetap PENDING dan bisa dicoba lagi', async () => {
  kosongkanFeedback();
  const a = await panggil('kirim_feedback_dawam', { isi: 'masukan yang digest-nya sempat gagal', kategori: 'BUG' }, RINA);

  const gagal = buatDeps({ gagalKe: [OPERATOR] });
  assert.equal((await power.kirimDigest(gagal)).status, 'GAGAL');
  assert.equal(db.getFeedbackPower(a.id).status, 'PENDING');
  assert.ok(!db.sudahKirimDigestHariIni());

  const berhasil = buatDeps();
  assert.equal((await power.kirimDigest(berhasil)).status, 'TERKIRIM');
  assert.equal(db.getFeedbackPower(a.id).status, 'TERKIRIM');
});

test('digest: pesan panjang dipecah, tidak ada feedback terpotong di tengah baris', async () => {
  kosongkanFeedback();
  for (let i = 0; i < 40; i++) {
    await panggil('kirim_feedback_dawam', { isi: `masukan panjang nomor ${i} ${'kata '.repeat(60)}`.trim(), kategori: 'SARAN' }, i % 2 ? RINA : BUDI);
    // batas harian 10/user: hapus penghitung dengan memajukan tanggal
    db.db.prepare("UPDATE feedback_power SET tanggal = '2000-01-01'").run();
  }
  const deps = buatDeps({ rapikan: async () => ({}) });
  await power.kirimDigest(deps);
  assert.ok(deps.terkirim.length > 1, 'dipecah jadi beberapa pesan');
  for (const p of deps.terkirim) assert.ok(p.teks.length <= 3500 + 500, 'tiap pesan dalam batas');
  const gabung = deps.terkirim.map((p) => p.teks).join('\n');
  assert.equal((gabung.match(/• #/g) || []).length, 40, 'semua feedback ada tepat sekali');
});

// ========== susul digest yang terlewat ==========

test('susul digest: hanya setelah jam kirim, hanya kalau belum terkirim hari ini dan ada yang menunggu', async () => {
  kosongkanFeedback();
  const siang = new Date('2026-11-19T03:00:00Z'); // 10:00 WIB
  const malam = new Date('2026-11-19T15:00:00Z'); // 22:00 WIB

  assert.equal(await power.susulDigestJikaTerlewat(buatDeps(), '0 21 * * *', malam), null, 'tidak ada feedback');

  await panggil('kirim_feedback_dawam', { isi: 'masukan yang menunggu digest malam', kategori: 'SARAN' }, RINA);
  const dini = buatDeps();
  assert.equal(await power.susulDigestJikaTerlewat(dini, '0 21 * * *', siang), null, 'belum jam kirim');
  assert.equal(dini.terkirim.length, 0);
  assert.equal(await power.susulDigestJikaTerlewat(dini, 'bukan cron', malam), null, 'cron tidak dikenali = tidak menyusul');

  const susul = buatDeps();
  const r = await power.susulDigestJikaTerlewat(susul, '0 21 * * *', malam);
  assert.equal(r.status, 'TERKIRIM');
  assert.equal(susul.terkirim.length, 1);

  await panggil('kirim_feedback_dawam', { isi: 'masukan baru setelah digest hari ini', kategori: 'SARAN' }, BUDI);
  assert.equal(await power.susulDigestJikaTerlewat(buatDeps(), '0 21 * * *', malam), null, 'digest hari ini sudah terkirim');
});

test('jamDariCron: hanya bentuk "M H * * *"', () => {
  assert.deepEqual(power.jamDariCron('0 21 * * *'), { menit: 0, jam: 21 });
  assert.deepEqual(power.jamDariCron('30 9 * * *'), { menit: 30, jam: 9 });
  assert.equal(power.jamDariCron('0 */3 * * *'), null);
  assert.equal(power.jamDariCron('0 25 * * *'), null);
});

// ========== perintah operator ==========

test('perintah operator: kelola power user (tambah, dobel, hapus, tidak bisa hapus operator, nomor tidak valid)', async () => {
  const deps = buatDeps();
  const jalan = (teks) => power.tanganiPerintahOperator(teks, OPERATOR, deps);
  const baru = '6281299990001@s.whatsapp.net';

  assert.match(await jalan('/power tambah 0812-9999-0001'), /sekarang power user/);
  assert.ok(db.isPowerUserDb(baru));
  assert.match(await jalan('/power tambah 081299990001'), /sudah power user/);
  assert.match(await jalan('/power daftar'), /\+6281299990001/);
  assert.match(await jalan('/power tambah 0811-0000-111'), /operator/);
  assert.match(await jalan('/power tambah 12'), /belum valid/);
  assert.match(await jalan('/power hapus 081299990001'), /bukan power user lagi/);
  assert.ok(!db.isPowerUserDb(baru));
  assert.match(await jalan('/power hapus 081299990001'), /memang bukan/);
  assert.match(await jalan('/power hapus 08110000111'), /tidak bisa dihapus/);
  assert.match(await jalan('/power'), /Perintah operator/);
  assert.equal(deps.terkirim.length, 0, 'tidak ada pesan keluar tak terduga');
});

test('perintah operator: hanya pola /power dan /feedback yang dianggap perintah', () => {
  assert.ok(power.adalahPerintahOperator('/power daftar'));
  assert.ok(power.adalahPerintahOperator('  /Feedback selesai 1'));
  assert.ok(!power.adalahPerintahOperator('power daftar'));
  assert.ok(!power.adalahPerintahOperator('/powerful'));
  assert.ok(!power.adalahPerintahOperator('halo /power'));
});

test('feedback selesai: tiap pengirim dikabari SATU pesan berisi feedback-nya, operator dapat ringkasan', async () => {
  kosongkanFeedback();
  const a = await panggil('kirim_feedback_dawam', { isi: 'bug kartu telat', kategori: 'BUG' }, RINA);
  const b = await panggil('kirim_feedback_dawam', { isi: 'usul mode gelap kartu', kategori: 'SARAN' }, RINA);
  const c = await panggil('kirim_feedback_dawam', { isi: 'usul widget progress mingguan', kategori: 'SARAN' }, BUDI);
  const d = await panggil('kirim_feedback_dawam', { isi: 'belum dikerjakan, harus tetap menunggu', kategori: 'LAIN' }, BUDI);
  await power.kirimDigest(buatDeps()); // semua jadi TERKIRIM

  const deps = buatDeps();
  const balasan = await power.tanganiPerintahOperator(`/feedback selesai ${a.id}-${c.id},9999 sudah rilis versi baru`, OPERATOR, deps);

  assert.deepEqual(deps.terkirim.map((t) => t.jid).sort(), [BUDI, RINA].sort());
  const keRina = deps.terkirim.find((t) => t.jid === RINA).teks;
  assert.match(keRina, /Halo Rina/);
  assert.match(keRina, new RegExp(`#${a.id}: bug kartu telat`));
  assert.match(keRina, new RegExp(`#${b.id}: usul mode gelap kartu`));
  assert.match(keRina, /Catatan dari tim: sudah rilis versi baru/);
  assert.doesNotMatch(keRina, /widget/);
  const keBudi = deps.terkirim.find((t) => t.jid === BUDI).teks;
  assert.match(keBudi, new RegExp(`#${c.id}: usul widget`));
  assert.doesNotMatch(keBudi, new RegExp(`#${d.id}:`), 'feedback di luar rentang tidak ikut');

  assert.match(balasan, /Selesai: #\d+, #\d+, #\d+/);
  assert.match(balasan, /Rina, Budi|Budi, Rina/);
  assert.match(balasan, /Tidak ditemukan: #9999/);
  assert.equal(db.getFeedbackPower(a.id).status, 'SELESAI');
  assert.equal(db.getFeedbackPower(a.id).catatan_selesai, 'sudah rilis versi baru');
  assert.ok(db.getFeedbackPower(a.id).user_diberitahu_pada);
  assert.equal(db.getFeedbackPower(d.id).status, 'TERKIRIM');

  // diulang: tidak dikabari dua kali
  const ulang = buatDeps();
  const balasanUlang = await power.tanganiPerintahOperator(`/feedback selesai ${a.id}-${c.id}`, OPERATOR, ulang);
  assert.equal(ulang.terkirim.length, 0);
  assert.match(balasanUlang, /Sudah selesai sebelumnya/);
});

test('feedback selesai: gagal mengabari satu user tidak menggagalkan yang lain, dan dilaporkan ke operator', async () => {
  kosongkanFeedback();
  const a = await panggil('kirim_feedback_dawam', { isi: 'masukan Rina yang selesai duluan', kategori: 'BUG' }, RINA);
  const b = await panggil('kirim_feedback_dawam', { isi: 'masukan Budi yang selesai duluan', kategori: 'BUG' }, BUDI);

  const deps = buatDeps({ gagalKe: [RINA] });
  const balasan = await power.tanganiPerintahOperator(`/feedback selesai ${a.id}-${b.id}`, OPERATOR, deps);
  assert.deepEqual(deps.terkirim.map((t) => t.jid), [BUDI]);
  assert.match(balasan, /Gagal dikabari: Rina/);
  assert.equal(db.getFeedbackPower(a.id).status, 'SELESAI', 'status tetap selesai');
  assert.equal(db.getFeedbackPower(a.id).user_diberitahu_pada, null);
  assert.ok(db.getFeedbackPower(b.id).user_diberitahu_pada);
});

test('feedback selesai: nomor tidak jelas -> petunjuk, tidak ada yang berubah; /feedback daftar & kirim', async () => {
  kosongkanFeedback();
  const a = await panggil('kirim_feedback_dawam', { isi: 'masukan yang belum selesai sama sekali', kategori: 'SARAN' }, RINA);
  const deps = buatDeps();
  const jalan = (t) => power.tanganiPerintahOperator(t, OPERATOR, deps);

  assert.match(await jalan('/feedback selesai semua'), /Sebutkan nomor/);
  assert.equal(db.getFeedbackPower(a.id).status, 'PENDING');

  const daftar = await jalan('/feedback daftar');
  assert.match(daftar, new RegExp(`#${a.id} \\[SARAN\\] Rina`));
  assert.match(daftar, /belum masuk digest/);

  assert.match(await jalan('/feedback kirim'), /Digest terkirim \(1 feedback\)/);
  assert.equal(deps.terkirim.filter((t) => t.jid === OPERATOR).length, 1);
  assert.match(await jalan('/feedback kirim'), /Tidak ada feedback baru/);

  await jalan(`/feedback selesai ${a.id}`);
  assert.match(await jalan('/feedback daftar'), /Tidak ada feedback yang belum selesai/);
});

test('migrasi aman diulang: tabel baru memakai IF NOT EXISTS dan tidak mengubah tabel lama', () => {
  const tabel = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const t of ['power_users', 'feedback_power', 'feedback_digest_log', 'users', 'feedback_berhenti']) {
    assert.ok(tabel.includes(t), t);
  }
  const kolomUsers = db.db.prepare('PRAGMA table_info(users)').all().map((k) => k.name);
  assert.ok(!kolomUsers.includes('is_power_user'), 'tabel users tidak dimodifikasi');
});
