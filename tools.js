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
  {
    type: 'function',
    function: {
      name: 'broadcast_ke_grup_sosial',
      description: 'Kirim pesan ke grup sosial user (setelah user mengkonfirmasi isi pesannya). JANGAN panggil sebelum user eksplisit setuju dengan isi pesan yang akan dikirim.',
      parameters: {
        type: 'object',
        properties: {
          isi_pesan: {
            type: 'string',
            description: 'Isi pesan yang akan dikirim ke grup, sudah disepakati dengan user.',
          },
        },
        required: ['isi_pesan'],
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
      description: 'Ambil rekap progress tilawah semua anggota grup ini. Panggil kalau ada yang tanya progress grup / siapa aja yang udah jalan, dalam bentuk jawaban singkat natural.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'minta_rekap_harian',
      description: 'Kirim pesan rekap harian progress grup (termasuk persen capaian dari target harian, dan otomatis nge-tag anggota yang belum baca sama sekali hari ini) ke grup ini SEKARANG JUGA. Panggil kalau ada yang eksplisit minta "kirim rekap harian", "berapa persen progress hari ini", "tag yang belum baca/belum tilawah hari ini", atau semacamnya -- beda dari get_rekap_progress_grup yang untuk pertanyaan spontan biasa tanpa perlu kirim pesan rekap terpisah.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_grup_sosial_ini',
      description: 'Jadikan grup ini sebagai grup sosial resmi pengirim pesan (tempat lapor progress & broadcast). Panggil kalau user eksplisit minta menghubungkan/memindahkan dirinya ke grup ini.',
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
  const sisaProgress = db.hitungSisaProgressUser(konteks.jid);
  return {
    sukses: true,
    posisi_terakhir: bacaan?.surat_ayat || 'belum mulai membaca',
    juz_sekarang: bacaan?.juz ?? null,
    halaman_posisi_sekarang: sisaProgress.halaman_posisi_sekarang,
    halaman_ditempuh: sisaProgress.halaman_ditempuh,
    total_halaman_keseluruhan: sisaProgress.total_halaman_keseluruhan,
    target_hari_per_juz: user.target_juz_per_hari || 'belum ditentukan',
    hari_berjalan: db.hitungHariBerjalanUser(konteks.jid),
    mode_saat_ini: user.mode_baca_arab_saja === 1 ? 'arab' : 'terjemah-saja (halangan)',
    status_pace: sisaProgress.status || null,
    selisih_dari_target: sisaProgress.selisih_tampilan || null,
    catatan_untuk_ai: 'posisi_terakhir/juz_sekarang cuma LOKASI baca (bisa jadi user memang mulai dari situ, bukan berarti progress banyak). Progress SEBENARNYA ada di halaman_ditempuh (jumlah halaman yang sudah dibaca sejak mulai) dan selisih_dari_target (sudah final, pakai apa adanya, JANGAN dihitung ulang).',
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
  // Pindah posisi manual = titik berangkat baru -- reset start_bacaan_id juga,
  // supaya pace/progress dihitung ulang dari sini, bukan ketimpa hitungan lama.
  db.setStartBacaanId(konteks.jid, bacaan.id - 1);
  return {
    sukses: true,
    surat_ayat: bacaan.surat_ayat,
    catatan_untuk_ai: `Posisi bacaan user dipindah ke sekitar ${bacaan.surat_ayat}. Bacaan berikutnya yang dikirim akan mulai dari sini, dan progress/pace dihitung ulang dari titik ini.`,
  };
}

async function eksekusiBroadcastKeGrupSosial({ isi_pesan }, konteks) {
  const user = db.getUser(konteks.jid);
  if (!user.group_sosial_jid) {
    return {
      sukses: false,
      pesan: 'User belum terhubung ke grup sosial manapun. Beri tahu user untuk kirim pesan apa saja di grup yang mau dijadikan grup sosialnya, nanti otomatis terhubung.',
    };
  }

  const namaPengirim = user.name || 'Seseorang';
  const terkirim = await konteks.kirimKeGrup(user.group_sosial_jid, `${namaPengirim}: ${isi_pesan}`);

  if (!terkirim) {
    return { sukses: false, pesan: 'Gagal mengirim pesan ke grup.' };
  }

  db.catatAktivitasGroup(user.group_sosial_jid, konteks.jid, 'BROADCAST_PERSONAL', isi_pesan.slice(0, 200));

  return { sukses: true, catatan_untuk_ai: 'Pesan berhasil dikirim ke grup sosial. Beri tahu user singkat bahwa sudah terkirim.' };
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
  broadcast_ke_grup_sosial: eksekusiBroadcastKeGrupSosial,
  set_grup_sosial_ini: eksekusiSetGrupSosialIni,
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

async function eksekusiMintaRekapHarian(_, konteks) {
  const hasil = await konteks.kirimRekapHarian(konteks.groupJid);
  if (!hasil.terkirim) {
    return {
      sukses: false,
      pesan: 'Belum ada anggota grup yang aktivasi personal, jadi belum ada progress yang bisa direkap.',
    };
  }
  return {
    sukses: true,
    jumlah_ditag: hasil.jidUntukMention.length,
    catatan_untuk_ai: `Rekap harian (termasuk persen dari target, dan tag ke yang belum baca hari ini kalau ada) sudah terkirim sebagai pesan terpisah. JANGAN mengulang isi rekap/nama yang ditag lagi di balasanmu -- cukup balas singkat seperti "oke, rekapnya udah di atas ya 👆" atau semacamnya.`,
  };
}

async function eksekusiSetGrupSosialIni(_, konteks) {
  const berhasil = db.setGroupSosialJikaBelumAda(konteks.senderJid, konteks.groupJid);

  if (!berhasil) {
    return {
      sukses: false,
      pesan: 'User sudah terhubung ke grup sosial lain sebelumnya. Kalau mau pindah, perlu fitur ganti grup sosial (belum tersedia).',
    };
  }

  return { sukses: true, catatan_untuk_ai: 'Grup ini berhasil dijadikan grup sosial user. Beri tahu singkat bahwa mulai sekarang progressnya akan di-report ke sini.' };
}

const EKSEKUTOR_GRUP = {
  get_rekap_progress_grup: eksekusiGetRekapProgressGrup,
  minta_rekap_harian: eksekusiMintaRekapHarian,
  set_grup_sosial_ini: eksekusiSetGrupSosialIni,
};

module.exports = {
  TOOLS_PERSONAL,
  TOOLS_GRUP,
  EKSEKUTOR_PERSONAL,
  EKSEKUTOR_GRUP,
};