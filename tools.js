const db = require('./db');

// ========== SCHEMA — PERSONAL ==========

const TOOLS_PERSONAL = [
  {
    type: 'function',
    function: {
      name: 'get_progress_user',
      description: 'Ambil progress tilawah user saat ini: posisi bacaan terakhir, juz, target, hari berjalan. WAJIB dipanggil kalau user tanya soal progress mereka, jangan pernah mengarang.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kirim_bacaan_lanjutan',
      description: 'Kirim gambar bacaan Al-Quran berikutnya (Arab, atau terjemah-saja kalau user sedang mode halangan) ke user, lalu update posisi terakhirnya. Panggil kalau user minta lanjut baca / siap tilawah.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kirim_terjemah_bacaan',
      description: 'Kirim gambar terjemah dari bacaan Arab yang BARU SAJA dikirim (posisi yang sama, bukan lanjut ke ayat berikutnya). Panggil HANYA kalau user minta lihat artinya setelah baca Arab.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aktifkan_mode_terjemah_halangan',
      description: 'Aktifkan mode terjemah-saja (untuk user yang sedang halangan/haid, tidak ingin pegang mushaf Arab). Setelah ini, bacaan yang dikirim hanya terjemahnya.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nonaktifkan_mode_terjemah_halangan',
      description: 'Nonaktifkan mode terjemah-saja (user sudah selesai halangan/suci), kembali ke bacaan Arab normal.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'catat_user_belum_baca',
      description: 'Catat bahwa user belum sempat tilawah saat ditawari (user bilang "nanti"/belum siap). Menambah counter belum-baca, dan memberi tahu kalau sudah waktunya tanya alasan dengan lembut.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_preferensi_user',
      description: 'Ubah data preferensi user yang sudah onboarding: target khatam, motivasi personal, atau lokasi. Panggil kalau user minta ganti salah satu data ini.',
      parameters: {
        type: 'object',
        properties: {
          target_juz_per_hari: {
            type: 'string',
            enum: ['6', '3', '1'],
            description: 'Target baru: khatam 1 juz per berapa hari.',
          },
          motivasi_personal: {
            type: 'string',
            description: 'Motivasi personal baru, apa adanya sesuai yang disebutkan user.',
          },
          location: {
            type: 'string',
            description: 'Domisili/kota baru.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_posisi_bacaan',
      description: 'Pindahkan posisi bacaan user ke surat tertentu (bukan lanjut otomatis dari posisi terakhir). Panggil kalau user eksplisit minta mulai/pindah ke surat tertentu.',
      parameters: {
        type: 'object',
        properties: {
          nama_surat: {
            type: 'string',
            description: 'Nama surat yang diminta user, apa adanya (contoh: "Al-Baqarah", "Ar-Rahman").',
          },
        },
        required: ['nama_surat'],
      },
    },
  },
];

// ========== SCHEMA — GRUP ==========
// Grup TIDAK PERNAH dapat tool kirim bacaan.

const TOOLS_GRUP = [
  {
    type: 'function',
    function: {
      name: 'get_rekap_progress_grup',
      description: 'Ambil rekap progress tilawah semua anggota grup ini. Panggil kalau ada yang tanya progress grup / siapa aja yang udah jalan.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ========== EKSEKUTOR — PERSONAL ==========
// konteks wajib berisi: { jid, kirimBacaanLanjutan, kirimTerjemahBacaan }
// kirimBacaanLanjutan/kirimTerjemahBacaan adalah callback dari index.js (butuh akses sock),
// sama pola dengan konteks.kirimPesan di Harga Petani.

async function eksekusiGetProgressUser(_, konteks) {
  const user = db.getUser(konteks.jid);
  const bacaan = db.getBacaanById(user.last_sent_bacaan_id);
  return {
    sukses: true,
    posisi_terakhir: bacaan?.surat_ayat || 'belum mulai membaca',
    juz_sekarang: bacaan?.juz ?? null,
    target_hari_per_juz: user.target_juz_per_hari || 'belum ditentukan',
    hari_berjalan: db.hitungHariBerjalanUser(konteks.jid),
    mode_saat_ini: user.mode_baca_arab_saja === 1 ? 'arab' : 'terjemah-saja (halangan)',
  };
}

async function eksekusiKirimBacaanLanjutan(_, konteks) {
  return await konteks.kirimBacaanLanjutan();
}

async function eksekusiKirimTerjemahBacaan(_, konteks) {
  return await konteks.kirimTerjemahBacaan();
}

async function eksekusiAktifkanModeHalangan(_, konteks) {
  const user = db.getUser(konteks.jid);
  if (user.mode_baca_arab_saja === 0) {
    return { sukses: false, pesan: 'Mode terjemah-saja sudah aktif sebelumnya.' };
  }
  db.setModeArabSaja(konteks.jid, false);
  return { sukses: true, catatan_untuk_ai: 'Mode terjemah-saja berhasil diaktifkan. Beri tahu user dengan hangat, singkat.' };
}

async function eksekusiNonaktifkanModeHalangan(_, konteks) {
  const user = db.getUser(konteks.jid);
  if (user.mode_baca_arab_saja === 1) {
    return { sukses: false, pesan: 'User sudah dalam mode bacaan Arab normal.' };
  }
  db.setModeArabSaja(konteks.jid, true);
  return { sukses: true, catatan_untuk_ai: 'Mode kembali ke bacaan Arab normal. Beri tahu user dengan hangat, singkat.' };
}

async function eksekusiCatatUserBelumBaca(_, konteks) {
  db.incrementNoResponse(konteks.jid);
  db.setUserState(konteks.jid, 'IDLE');
  const user = db.getUser(konteks.jid);

  return {
    sukses: true,
    counter_belum_baca: user.consecutive_no_response,
    catatan_untuk_ai: user.consecutive_no_response >= 3
      ? `User sudah ${user.consecutive_no_response}x berturut-turut belum sempat tilawah. Tanyakan dengan lembut, TANPA menghakimi, apa yang membuatnya belum sempat.${user.motivasi_personal ? ` Ingatkan dengan motivasi personalnya sendiri: "${user.motivasi_personal}".` : ''}`
      : 'Tanggapi dengan hangat, tidak menghakimi, tetap menyemangati tanpa memaksa.',
  };
}

async function eksekusiUpdatePreferensiUser(args, konteks) {
  const fieldDiubah = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== null);
  if (fieldDiubah.length === 0) {
    return { sukses: false, pesan: 'Tidak ada data yang diubah.' };
  }
  db.updateUserFields(konteks.jid, args);
  return { sukses: true, field_diubah: fieldDiubah, data_baru: args };
}

async function eksekusiSetPosisiBacaan({ nama_surat }, konteks) {
  const bacaan = db.cariBacaanBySuratLike(nama_surat);
  if (!bacaan) {
    return { sukses: false, pesan: `Surat "${nama_surat}" tidak ditemukan di data bacaan.` };
  }
  db.updateLastSentBacaanId(konteks.jid, bacaan.id - 1);
  return {
    sukses: true,
    surat_ayat: bacaan.surat_ayat,
    catatan_untuk_ai: `Posisi bacaan user dipindah ke sekitar ${bacaan.surat_ayat}. Bacaan berikutnya yang dikirim akan mulai dari sini.`,
  };
}

const EKSEKUTOR_PERSONAL = {
  get_progress_user: eksekusiGetProgressUser,
  kirim_bacaan_lanjutan: eksekusiKirimBacaanLanjutan,
  kirim_terjemah_bacaan: eksekusiKirimTerjemahBacaan,
  aktifkan_mode_terjemah_halangan: eksekusiAktifkanModeHalangan,
  nonaktifkan_mode_terjemah_halangan: eksekusiNonaktifkanModeHalangan,
  catat_user_belum_baca: eksekusiCatatUserBelumBaca,
  update_preferensi_user: eksekusiUpdatePreferensiUser,
  set_posisi_bacaan: eksekusiSetPosisiBacaan,
};

// ========== EKSEKUTOR — GRUP ==========
// konteks wajib berisi: { groupJid }

async function eksekusiGetRekapProgressGrup(_, konteks) {
  const rekap = db.getRekapProgressGroup(konteks.groupJid);
  if (rekap.length === 0) {
    return { sukses: true, jumlah: 0, pesan: 'Belum ada anggota grup yang tercatat progress-nya.' };
  }
  return { sukses: true, jumlah: rekap.length, daftar: rekap };
}

const EKSEKUTOR_GRUP = {
  get_rekap_progress_grup: eksekusiGetRekapProgressGrup,
};

module.exports = {
  TOOLS_PERSONAL,
  TOOLS_GRUP,
  EKSEKUTOR_PERSONAL,
  EKSEKUTOR_GRUP,
};