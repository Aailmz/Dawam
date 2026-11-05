const { getUser, getBacaanById, hitungHariBerjalanUser } = require('./db');

const TOOLS_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'get_progress_user',
      description: 'Ambil progress tilawah user: posisi bacaan terakhir, juz, target, hari berjalan',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_rekomendasi_lanjutan',
      description: 'Ambil bacaan berikutnya yang akan dikirim kalau user lanjut baca',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// Setiap executor terima jid dari closure (dibuat per-request), BUKAN dari argumen
// model, supaya user tidak bisa minta data orang lain lewat prompt injection.
function buatToolExecutors(jid) {
  return {
    get_progress_user: () => {
      const user = getUser(jid);
      const bacaan = getBacaanById(user.last_sent_bacaan_id);
      return {
        posisi_terakhir: bacaan?.surat_ayat || 'belum mulai membaca',
        juz_sekarang: bacaan?.juz ?? null,
        target_hari_per_juz: user.target_juz_per_hari || 'belum ditentukan',
        hari_berjalan: hitungHariBerjalanUser(jid),
      };
    },
    get_rekomendasi_lanjutan: () => {
      const user = getUser(jid);
      let nextId = user.last_sent_bacaan_id + 1;
      if (nextId > 900) nextId = 1;
      const bacaan = getBacaanById(nextId);
      return bacaan
        ? { surat_ayat: bacaan.surat_ayat, juz: bacaan.juz }
        : { surat_ayat: null, catatan: 'data bacaan belum tersedia' };
    },
  };
}

module.exports = { TOOLS_SCHEMA, buatToolExecutors };