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
            enum: ['12', '6', '3', '1'],
            description: 'Target baru: khatam 1 juz per berapa hari. HANYA salah satu dari 4 nilai ini -- kalau user menyebut angka lain atau maksudnya ambigu, JANGAN panggil tool ini, tanyakan balik dulu ke user dengan menyebutkan ulang 4 pilihan yang ada.',
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
  {
    type: 'function',
    function: {
      name: 'tanya_bacaan_hari_lain',
      description: 'Ambil histori bacaan user di tanggal tertentu (bukan hari ini), misal user tanya "kemarin aku baca apa" atau "hari senin kemarin sampe mana". JANGAN mengarang, selalu panggil tool ini kalau user tanya soal bacaan hari-hari sebelumnya.',
      parameters: {
        type: 'object',
        properties: {
          tanggal_relatif: {
            type: 'string',
            enum: ['kemarin', 'dua_hari_lalu', 'tiga_hari_lalu'],
            description: 'Posisi hari yang dimaksud relatif terhadap hari ini.',
          },
        },
        required: ['tanggal_relatif'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'minta_berhenti_dawam',
      description: 'Hentikan sementara layanan Dawam untuk user ini (berhenti dapat reminder sholat & tilawah). WAJIB panggil tool ini HANYA SETELAH user benar-benar mengkonfirmasi mau berhenti DAN sudah diberi kesempatan kasih feedback/alasan (atau eksplisit bilang skip/tidak mau kasih alasan). JANGAN panggil di awal begitu user baru bilang "mau berhenti" -- tanya dulu alasannya secara natural, baru panggil tool ini setelah dia jawab (atau bilang tidak mau/skip).',
      parameters: {
        type: 'object',
        properties: {
          feedback: {
            type: 'string',
            description: 'Alasan/feedback berhenti dari user, apa adanya. Kosongkan/jangan isi field ini (omit) kalau user eksplisit tidak mau kasih alasan/skip.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aktifkan_kembali_dawam',
      description: 'Aktifkan kembali layanan Dawam untuk user yang sebelumnya berhenti/nonaktif. Panggil kalau user yang statusnya nonaktif bilang mau lanjut/aktif lagi/balik lagi.',
      parameters: { type: 'object', properties: {}, required: [] },
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
      name: 'tag_anggota_grup',
      description: 'Kirim pesan ke grup yang nge-tag (mention) anggota berdasarkan KRITERIA yang sudah ditentukan (bukan milih manual). Filter siapa yang kena tag dihitung otomatis dari data asli, supaya tidak salah tag. Panggil kalau user minta tag/sebut anggota sesuai salah satu kriteria yang tersedia. Kalau user minta tag orang SPESIFIK by nama (misal "tag si Mirza"), pakai kriteria nama_spesifik dan isi nama_target.',
      parameters: {
        type: 'object',
        properties: {
          kriteria: {
            type: 'string',
            enum: ['belum_aktivasi', 'belum_baca_hari_ini', 'di_bawah_pace', 'nama_spesifik'],
            description: 'belum_aktivasi: anggota yang belum pernah kirim "dawam" ke chat pribadi. belum_baca_hari_ini: sudah aktivasi tapi belum baca sama sekali hari ini. di_bawah_pace: sudah aktivasi dan statusnya di bawah target pace (hanya relevan buat yang punya target cepat). nama_spesifik: satu orang tertentu by nama, isi nama_target.',
          },
          nama_target: {
            type: 'string',
            description: 'WAJIB diisi kalau kriteria=nama_spesifik. Nama anggota yang dimaksud, apa adanya sesuai disebut user.',
          },
          pesan_pembuka: {
            type: 'string',
            description: 'Kalimat singkat sebelum tag, sesuai konteks permintaan user (misal: "Yuk yang belum gabung, kirim dawam ke chat pribadi ya").',
          },
        },
        required: ['kriteria', 'pesan_pembuka'],
      },
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
  {
    type: 'function',
    function: {
      name: 'klaim_card_kawan',
      description: 'Panggil kalau seseorang di grup bilang mau baca/klaim card lanjutan milik anggota lain yang sedang ditawarkan (konteks lelang Isya), misal "aku baca punya si A ya" atau "gas punya Fulan". Card akan dikirim PERSONAL ke orang yang klaim (bukan ke grup). Panggil HANYA kalau ada nama target yang jelas disebut dan sedang dalam konteks tawaran lelang yang masih berlaku.',
      parameters: {
        type: 'object',
        properties: {
          nama_target: {
            type: 'string',
            description: 'Nama anggota yang card-nya mau diklaim/dibaca, sesuai disebut user.',
          },
        },
        required: ['nama_target'],
      },
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

async function eksekusiTanyaBacaanHariLain({ tanggal_relatif }, konteks) {
  const mapHari = { kemarin: 1, dua_hari_lalu: 2, tiga_hari_lalu: 3 };
  const mundur = mapHari[tanggal_relatif] || 1;
  const tanggal = new Date();
  tanggal.setDate(tanggal.getDate() - mundur);
  const tanggalISO = tanggal.toISOString().slice(0, 10);

  const log = db.getLogBacaanHarianByTanggal(konteks.jid, tanggalISO);
  if (!log) {
    return {
      sukses: true,
      ada_data: false,
      tanggal: tanggalISO,
      pesan: 'Tidak ada catatan bacaan di tanggal itu (kemungkinan user tidak tilawah hari itu).',
    };
  }
  return {
    sukses: true,
    ada_data: true,
    tanggal: tanggalISO,
    surat_ayat_terakhir: log.surat_ayat_akhir,
    jumlah_kartu: log.jumlah_kartu,
  };
}

async function eksekusiMintaBerhentiDawam({ feedback }, konteks) {
  if (feedback) {
    db.simpanFeedbackBerhenti(konteks.jid, feedback);
  }
  db.nonaktifkanUser(konteks.jid);
  return {
    sukses: true,
    feedback_tersimpan: !!feedback,
    catatan_untuk_ai: 'Dawam berhasil dinonaktifkan untuk user ini. Beri tahu dengan hangat bahwa reminder sholat & tilawah akan berhenti, TANPA menghakimi keputusannya, dan beri tahu dia bisa aktif lagi kapan saja cukup dengan bilang ke Dawam (misal "aktifin lagi" / "lanjut lagi") kapanpun dia mau.',
  };
}

async function eksekusiAktifkanKembaliDawam(_, konteks) {
  const user = db.getUser(konteks.jid);
  if (user.is_active === 1) {
    return { sukses: false, pesan: 'User sudah dalam status aktif sebelumnya.' };
  }
  db.aktifkanKembaliUser(konteks.jid);
  return {
    sukses: true,
    catatan_untuk_ai: 'Dawam berhasil diaktifkan kembali. Sambut hangat, beri tahu singkat bahwa reminder sholat & tilawah akan jalan lagi seperti biasa (progress & data lama tetap tersimpan, tidak hilang).',
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
  tanya_bacaan_hari_lain: eksekusiTanyaBacaanHariLain,
  minta_berhenti_dawam: eksekusiMintaBerhentiDawam,
  aktifkan_kembali_dawam: eksekusiAktifkanKembaliDawam,
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

async function eksekusiTagAnggotaGrup({ kriteria, nama_target, pesan_pembuka }, konteks) {
  const dataRekap = db.getRekapProgressGroup(konteks.groupJid);

  let targetList;
  switch (kriteria) {
    case 'belum_aktivasi':
      targetList = dataRekap.filter((d) => !d.sudah_aktivasi_personal);
      break;
    case 'belum_baca_hari_ini':
      targetList = dataRekap.filter((d) => d.sudah_aktivasi_personal && !d.sudah_baca_hari_ini);
      break;
    case 'di_bawah_pace':
      targetList = dataRekap.filter((d) => d.sudah_aktivasi_personal && d.status_pace === 'DI_BAWAH_PACE');
      break;
    case 'nama_spesifik': {
      if (!nama_target) {
        return { sukses: false, pesan: 'nama_target wajib diisi untuk kriteria nama_spesifik.' };
      }
      const namaLower = nama_target.trim().toLowerCase();
      targetList = dataRekap.filter((d) => (d.nama || '').toLowerCase().includes(namaLower));
      break;
    }
    default:
      return { sukses: false, pesan: `Kriteria "${kriteria}" tidak dikenali.` };
  }

  const jidList = targetList.map((d) => d.jid).filter(Boolean);

  if (jidList.length === 0) {
    return {
      sukses: false,
      pesan: `Tidak ada anggota yang cocok dengan kriteria "${kriteria}"${nama_target ? ` (nama: ${nama_target})` : ''}.`,
    };
  }

  const terkirim = await konteks.kirimTagKeGrup(konteks.groupJid, pesan_pembuka, jidList);
  if (!terkirim) {
    return { sukses: false, pesan: 'Gagal mengirim tag ke grup.' };
  }
  return {
    sukses: true,
    jumlah_ditag: jidList.length,
    nama_yang_ditag: targetList.map((d) => d.nama),
    catatan_untuk_ai: 'Pesan tag sudah terkirim sebagai pesan terpisah. Balas singkat saja, JANGAN mengulang isi pesan/nama yang ditag.',
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

// Klaim card lelang Isya -- cari apakah ada tawaran aktif untuk nama_target di grup ini,
// kalau ada, kirim card LANJUTAN milik nama_target secara PERSONAL ke yang klaim (senderJid),
// bukan ke grup. Grup cuma dapat teks konfirmasi.
async function eksekusiKlaimCardKawan({ nama_target }, konteks) {
  const tawaran = konteks.ambilTawaranLelangAktif(konteks.groupJid, nama_target);
  if (!tawaran) {
    return {
      sukses: false,
      pesan: `Tidak ada tawaran lelang aktif untuk "${nama_target}" di grup ini saat ini (mungkin sudah diklaim orang lain, atau belum pernah ditawarkan hari ini).`,
    };
  }

  const hasilKirim = await konteks.kirimCardLelangPersonal(konteks.senderJid, tawaran.jid);
  if (!hasilKirim.sukses) {
    return { sukses: false, pesan: hasilKirim.pesan || 'Gagal mengirim card.' };
  }

  konteks.tandaiTawaranSudahDiklaim(konteks.groupJid, tawaran.jid);

  return {
    sukses: true,
    nama_pemilik_card: tawaran.nama,
    catatan_untuk_ai: `Card lanjutan milik ${tawaran.nama} berhasil dikirim PERSONAL ke chat pribadi yang klaim. Beri tahu singkat di grup bahwa card sudah dikirim ke chat pribadinya, tanpa perlu detail isi bacaannya.`,
  };
}

const EKSEKUTOR_GRUP = {
  get_rekap_progress_grup: eksekusiGetRekapProgressGrup,
  minta_rekap_harian: eksekusiMintaRekapHarian,
  tag_anggota_grup: eksekusiTagAnggotaGrup,
  set_grup_sosial_ini: eksekusiSetGrupSosialIni,
  klaim_card_kawan: eksekusiKlaimCardKawan,
};

module.exports = {
  TOOLS_PERSONAL,
  TOOLS_GRUP,
  EKSEKUTOR_PERSONAL,
  EKSEKUTOR_GRUP,
};