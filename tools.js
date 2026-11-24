const db = require('./db');
const power = require('./power');

// Cooldown in-memory untuk tool yang menulis ke grup, supaya satu orang tidak bisa membuat bot
// spam grup. cekCooldown = sisa ms (0 kalau boleh); tandaiCooldown dipanggil SETELAH berhasil kirim.
const terakhirDipakai = new Map();
function cekCooldown(kunci, jedaMs) {
  const sisa = (terakhirDipakai.get(kunci) || 0) + jedaMs - Date.now();
  return sisa > 0 ? sisa : 0;
}
function tandaiCooldown(kunci) {
  terakhirDipakai.set(kunci, Date.now());
}
const COOLDOWN_REKAP_MS = 10 * 60 * 1000;
const COOLDOWN_TAG_MS = 3 * 60 * 1000;
const COOLDOWN_BROADCAST_MS = 60 * 1000;

// Laporan/koreksi yang melompat jauh butuh DUA panggilan dengan argumen sama pada giliran (pesan
// user) yang BERBEDA, supaya "konfirmasi" benar-benar datang dari user, bukan AI memanggil ulang
// sendiri. (Dulu tool menolak terus walau user sudah mengonfirmasi.)
const MASA_KONFIRMASI_MS = 10 * 60 * 1000;
const laporMenunggu = new Map(); // jid -> { urutan, sampai, giliranId }
const koreksiMenunggu = new Map(); // jid -> { urutan, sampai, giliranId }
function sudahDikonfirmasi(peta, jid, urutan, giliranId) {
  const m = peta.get(jid);
  const valid = m && m.urutan === urutan && m.sampai >= Date.now() && m.giliranId !== giliranId;
  if (valid) peta.delete(jid);
  else peta.set(jid, { urutan, sampai: Date.now() + MASA_KONFIRMASI_MS, giliranId });
  return !!valid;
}

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
      name: 'get_info_mushaf',
      description: 'Ambil data FAKTA soal struktur mushaf Dawam: total kartu/card keseluruhan, dan jumlah kartu di tiap juz (1-30). WAJIB panggil ini kalau user tanya soal total kartu, berapa kartu di suatu juz, atau pertanyaan struktural lain soal mushaf -- JANGAN mengarang angka ini dari asumsi (jumlah kartu per juz TIDAK rata/sama).',
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
      name: 'lapor_bacaan_manual',
      description: 'Catat laporan bacaan manual (perkiraan jumlah KARTU) dari user, untuk SEMUA mode (reminder-saja maupun kartu -- user mode kartu juga bisa baca di luar kartu, misal dari mushaf/app lain). WAJIB panggil ini (setelah konfirmasi rentang bacaan ke user) kalau user melaporkan sudah baca berapa kartu hari ini; tanpa pemanggilan tool ini laporannya TIDAK tercatat dan tidak masuk rekap harian. Kalau user menyebut surat+ayat spesifik, pakai lapor_bacaan_by_ayat.',
      parameters: {
        type: 'object',
        properties: {
          jumlah_kartu: {
            type: 'number',
            description: 'Jumlah KARTU yang BARU SAJA dibaca user HARI INI (satuan resmi Dawam, bilangan bulat). Kalau user cuma bilang "udah baca" tanpa angka/kuantitas sama sekali, JANGAN panggil tool ini -- tanya dulu bacaannya (paling enak surat+ayat dari mana sampai mana; kalau cuma bisa jumlah, tanyakan perkiraannya).',
          },
          jumlah_halaman: {
            type: 'number',
            description: 'HANYA kalau user menyebut jumlah HALAMAN mushaf cetak (bukan kartu), isi ini, dan JANGAN isi jumlah_kartu. Sistem yang mengonversinya ke kartu. Jangan menghitung sendiri.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lapor_bacaan_by_ayat',
      description: 'Catat progress bacaan berdasarkan surat+ayat yang disebut user (bukan perkiraan jumlah kartu), untuk SEMUA mode (reminder-saja maupun kartu), supaya tidak ada ketidaksesuaian antara card Dawam dan bacaan user di mushaf/app lain. Posisi akan di-set ke card yang mengandung ayat tersebut dan jumlah kartu yang maju ikut dihitung ke target hari ini. WAJIB panggil ini (bukan lapor_bacaan_manual) kalau user menyebutkan surat+ayat spesifik, misal "udah sampe Al-Baqarah ayat 50"; tanpa pemanggilan tool ini laporannya TIDAK tercatat dan tidak masuk rekap harian.',
      parameters: {
        type: 'object',
        properties: {
          nama_surat: {
            type: 'string',
            description: 'Nama surat yang disebutkan user, apa adanya (contoh: "Al-Baqarah").',
          },
          nomor_ayat: {
            type: 'number',
            description: 'Nomor ayat yang disebutkan user.',
          },
          dari_nama_surat: {
            type: 'string',
            description: 'OPSIONAL. Isi HANYA kalau user menyebut titik MULAI bacaannya ("tadi baca dari An-Nisa ayat 1 sampai ayat 20"). Nama surat titik mulai. Kalau user hanya menyebut titik akhir, JANGAN diisi.',
          },
          dari_nomor_ayat: {
            type: 'number',
            description: 'OPSIONAL. Nomor ayat titik mulai; wajib diisi bersama dari_nama_surat.',
          },
        },
        required: ['nama_surat', 'nomor_ayat'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'koreksi_catatan_bacaan',
      description: 'Perbaiki catatan bacaan yang SALAH tercatat oleh Dawam, berdasarkan komplain/koreksi eksplisit dari user (misal "itu salah, aku kemarin baca lebih banyak", "posisiku bukan di situ, harusnya..."). WAJIB konfirmasi dulu detail koreksinya ke user sebelum panggil tool ini, dan panggil HANYA setelah user benar-benar mengonfirmasi (bilang "iya"/"benar"/"betul" dsb). JANGAN panggil tool ini untuk laporan bacaan BARU (pakai lapor_bacaan_by_ayat/lapor_bacaan_manual untuk itu) -- ini KHUSUS untuk membetulkan catatan yang SUDAH ada tapi keliru, TERMASUK kalau jumlah kartu yang tercatat terlalu sedikit/banyak (isi dari_nama_surat+dari_nomor_ayat atau jumlah_kartu supaya total kartu tanggal itu ditimpa dengan angka yang benar).',
      parameters: {
        type: 'object',
        properties: {
          jenis_koreksi: {
            type: 'string',
            enum: ['posisi_sekarang', 'log_tanggal_tertentu'],
            description: 'posisi_sekarang: betulkan posisi bacaan terkini user (last_sent_bacaan_id). log_tanggal_tertentu: betulkan catatan di tanggal TERTENTU di masa lalu (termasuk hari ini).',
          },
          nama_surat: {
            type: 'string',
            description: 'Nama surat yang BENAR menurut user, apa adanya.',
          },
          nomor_ayat: {
            type: 'number',
            description: 'Nomor ayat yang BENAR menurut user.',
          },
          tanggal_relatif: {
            type: 'string',
            enum: ['hari_ini', 'kemarin', 'dua_hari_lalu', 'tiga_hari_lalu'],
            description: 'WAJIB diisi kalau jenis_koreksi=log_tanggal_tertentu. Tanggal mana yang mau dikoreksi.',
          },
          dari_nama_surat: {
            type: 'string',
            description: 'OPSIONAL, hanya untuk log_tanggal_tertentu. Nama surat titik MULAI bacaan yang benar (misal user: "harusnya dari At-Tin ayat 1 sampai An-Nas ayat 6"). Kalau diisi, total kartu tanggal itu DITIMPA dengan jumlah kartu dari titik mulai sampai titik akhir (nama_surat/nomor_ayat).',
          },
          dari_nomor_ayat: {
            type: 'number',
            description: 'OPSIONAL. Nomor ayat titik mulai; wajib diisi bersama dari_nama_surat.',
          },
          jumlah_kartu: {
            type: 'number',
            description: 'OPSIONAL, hanya untuk log_tanggal_tertentu. Kalau user menyebut langsung total KARTU yang benar untuk tanggal itu ("harusnya 12 kartu"), isi ini: total kartu tanggal itu DITIMPA (bukan ditambah). Jangan isi kalau dari_nama_surat sudah diisi.',
          },
          alasan_koreksi: {
            type: 'string',
            description: 'Ringkasan singkat alasan/komplain user, apa adanya, buat jejak audit.',
          },
        },
        required: ['jenis_koreksi', 'nama_surat', 'nomor_ayat', 'alasan_koreksi'],
      },
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
      name: 'atur_fitur_dawam',
      description: 'Nyalakan/matikan salah satu fitur personal Dawam sesuai request user, ATAU ganti bentuk kartu bacaan jadi reminder-saja (tanpa gambar). Isi HANYA field yang user minta ubah, biarkan field lain undefined.',
      parameters: {
        type: 'object',
        properties: {
          reminder_sholat_aktif: { type: 'boolean', description: 'Reminder sholat 5 waktu. false = dimatikan total.' },
          tawaran_tilawah_aktif: { type: 'boolean', description: 'Tawaran tilawah 10 menit setelah reminder sholat. false = tidak ditawarin tilawah sama sekali (reminder sholat tetap jalan kalau itu juga aktif).' },
          tawaran_alkahfi_aktif: { type: 'boolean', description: 'Tawaran baca Al-Kahfi tiap Jumat pagi.' },
          reminder_jumat_laki_aktif: { type: 'boolean', description: 'Reminder sholat Jumat khusus laki-laki (15 menit sebelum Dzuhur). Hanya relevan untuk user gender L.' },
          bentuk_bacaan: {
            type: 'string',
            enum: ['kartu', 'reminder'],
            description: '"kartu" = kirim gambar bacaan seperti biasa (default). "reminder" = JANGAN kirim gambar sama sekali, cukup kirim pesan teks pengingat buat baca dari mushaf sendiri, posisi tidak otomatis bertambah.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pengaturan_user',
      description: 'Ambil status on/off semua fitur personal Dawam untuk user ini (reminder sholat, tawaran tilawah, tawaran Al-Kahfi, reminder Jumat laki-laki, bentuk bacaan kartu/reminder). WAJIB panggil ini kalau user tanya "fitur apa aja yang aktif/nonaktif", "pengaturanku gimana", atau sejenisnya -- JANGAN mengarang statusnya.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_posisi_bacaan',
      description: 'HANYA untuk user yang MULAI PERTAMA KALI minta pindah ke surat yang BELUM pernah dia baca sebelumnya di progress khataman utamanya (misal "mulai dari Ar-Rahman aja"). JANGAN PERNAH panggil ini kalau: (1) user minta "lanjut"/"balik lagi" ke surat yang sebelumnya SUDAH dia baca (termasuk balik ke Al-Baqarah setelah mampir ke surat lain) -- itu artinya last_sent_bacaan_id SUDAH berubah karena hal lain dan harus dibenerin manual, BUKAN di-reset lagi; (2) untuk Al-Kahfi dalam bentuk apapun -- Al-Kahfi PUNYA TRACKING SENDIRI (last_sent_alkahfi_id) lewat tool kirim_card_alkahfi_lanjutan, TIDAK ADA tool ini yang boleh dipanggil untuknya. Tool ini mereset start_bacaan_id, jadi salah pakai = progress user hilang.',
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
      description: 'Hentikan sementara layanan Dawam untuk user ini (berhenti dapat reminder sholat & tilawah). WAJIB panggil tool ini HANYA SETELAH user mengkonfirmasi mau berhenti DAN sudah diberi kesempatan kasih feedback/alasan. JANGAN panggil di awal begitu user baru bilang "mau berhenti" -- tanya dulu alasannya secara natural, baru panggil tool ini setelah dia jawab.',
      parameters: {
        type: 'object',
        properties: {
          feedback: {
            type: 'string',
            description: 'Alasan/feedback berhenti dari user, apa adanya.',
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

// ========== SCHEMA — POWER USER (hanya diberikan ke power user, lihat toolsPersonalUntuk) ==========

const TOOLS_POWER = [
  {
    type: 'function',
    function: {
      name: 'kirim_feedback_dawam',
      description: 'Catat masukan/feedback dari Power User tentang Dawam (laporan bug/error, usul fitur, keluhan, ide perbaikan) supaya diteruskan ke tim pengembang. WAJIB dipanggil kalau power user menyampaikan masukan yang sudah jelas; tanpa pemanggilan tool ini masukannya TIDAK tersimpan. Kalau masukannya masih kabur atau kamu ragu ini masukan atau obrolan biasa, tanya dulu ke user sebelum memanggil.',
      parameters: {
        type: 'object',
        properties: {
          isi: {
            type: 'string',
            description: 'Isi masukan sesuai maksud user, dengan semua detail yang dia sebut (apa yang terjadi, apa yang diharapkan, contohnya). Boleh menggabungkan beberapa pesan terakhirnya. Jangan menambah hal yang tidak dia katakan.',
          },
          kategori: {
            type: 'string',
            enum: ['BUG', 'SARAN', 'KELUHAN', 'LAIN'],
            description: 'BUG = ada yang error/salah/tidak jalan. SARAN = usul fitur atau perbaikan. KELUHAN = tidak nyaman/kurang puas tanpa permintaan spesifik. LAIN = selain itu.',
          },
        },
        required: ['isi', 'kategori'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ubah_feedback_dawam',
      description: 'Ubah/lengkapi isi feedback MILIK USER INI yang barusan dicatat, kalau dia mengoreksi atau menambah detail. Hanya berhasil selama feedback belum diteruskan ke tim; kalau gagal karena sudah diteruskan, catat sebagai feedback baru lewat kirim_feedback_dawam.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Nomor feedback (yang kamu sebut ke user saat mencatat, tanpa tanda #).' },
          isi_baru: { type: 'string', description: 'Isi feedback LENGKAP setelah diperbarui (bukan hanya tambahannya).' },
          kategori: { type: 'string', enum: ['BUG', 'SARAN', 'KELUHAN', 'LAIN'], description: 'Isi hanya kalau kategorinya perlu diganti.' },
        },
        required: ['id', 'isi_baru'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_feedback_saya',
      description: 'Ambil daftar feedback terakhir milik user ini beserta statusnya (menunggu diteruskan / sudah diteruskan ke tim / sudah dikerjakan). Panggil kalau user tanya soal status masukannya ("udah sampai belum", "yang kemarin gimana"). Jangan mengarang status.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// Tool power hanya ikut diberikan ke power user (operator termasuk). User biasa tidak melihatnya.
function toolsPersonalUntuk(jid) {
  return power.isPowerUser(jid) ? [...TOOLS_PERSONAL, ...TOOLS_POWER] : TOOLS_PERSONAL;
}

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
      name: 'get_info_mushaf',
      description: 'Ambil data FAKTA soal struktur mushaf Dawam: total kartu/card keseluruhan, dan jumlah kartu di tiap juz (1-30). WAJIB panggil ini kalau user tanya soal total kartu, berapa kartu di suatu juz, atau pertanyaan struktural lain soal mushaf -- JANGAN mengarang angka ini dari asumsi (jumlah kartu per juz TIDAK rata/sama).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lapor_bacaan_manual',
      description: 'Catat laporan bacaan (perkiraan jumlah KARTU) milik ORANG YANG BICARA di grup ini, supaya masuk rekap harian. WAJIB panggil kalau si pengirim pesan melaporkan sudah baca sekian kartu hari ini; tanpa pemanggilan tool ini laporannya TIDAK tercatat. Hanya untuk pengirim pesan sendiri, bukan untuk orang lain. Kalau pengirim cuma bilang "udah baca" tanpa angka sama sekali, JANGAN panggil, tanya dulu bacaannya (paling enak surat+ayat dari mana sampai mana; kalau cuma bisa jumlah, tanyakan perkiraannya).',
      parameters: {
        type: 'object',
        properties: {
          jumlah_kartu: {
            type: 'number',
            description: 'Jumlah KARTU yang BARU SAJA dibaca pengirim HARI INI (satuan resmi Dawam, bilangan bulat), sesuai pesannya.',
          },
          jumlah_halaman: {
            type: 'number',
            description: 'HANYA kalau pengirim menyebut jumlah HALAMAN mushaf cetak (bukan kartu), isi ini, dan JANGAN isi jumlah_kartu. Sistem yang mengonversinya ke kartu.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lapor_bacaan_by_ayat',
      description: 'Catat progress bacaan milik ORANG YANG BICARA di grup berdasarkan surat+ayat yang dia sebut (misal "udah sampe Al-Baqarah ayat 50"), supaya masuk rekap harian. WAJIB panggil (bukan lapor_bacaan_manual) kalau pengirim menyebut surat+ayat spesifik; tanpa pemanggilan tool ini laporannya TIDAK tercatat. Hanya untuk pengirim pesan sendiri.',
      parameters: {
        type: 'object',
        properties: {
          nama_surat: { type: 'string', description: 'Nama surat yang disebutkan, apa adanya (contoh: "Al-Baqarah").' },
          nomor_ayat: { type: 'number', description: 'Nomor ayat yang disebutkan.' },
          dari_nama_surat: { type: 'string', description: 'OPSIONAL. Isi HANYA kalau pengirim menyebut titik MULAI bacaannya ("dari An-Nisa 1 sampai 20"). Nama surat titik mulai.' },
          dari_nomor_ayat: { type: 'number', description: 'OPSIONAL. Nomor ayat titik mulai; wajib diisi bersama dari_nama_surat.' },
        },
        required: ['nama_surat', 'nomor_ayat'],
      },
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

async function eksekusiLaporBacaanManual(args, konteks) {
  // Satuan resmi = KARTU. Kalau user menyebut halaman mushaf cetak, sistem yang mengonversi ke kartu.
  const kartuMentah = args.jumlah_kartu !== undefined && args.jumlah_kartu !== null && args.jumlah_kartu !== ''
    ? Number(args.jumlah_kartu)
    : (args.jumlah_halaman !== undefined && args.jumlah_halaman !== null && args.jumlah_halaman !== ''
      ? db.halamanKeKartu(Number(args.jumlah_halaman))
      : NaN);
  const jumlah_kartu = Math.round(kartuMentah);
  const user = db.getUser(konteks.jid);
  const modeKartu = user.bentuk_bacaan !== 'reminder';
  const gapHari = hitungGapHariTanpaLapor(konteks.jid);

  // Batas wajar per hari ~3 juz (dulu 60 halaman mushaf), dalam kartu.
  const BATAS_WAJAR_PER_HARI = Math.round(db.kartuPerHalaman() * 60);

  if (!Number.isFinite(jumlah_kartu) || jumlah_kartu <= 0 || jumlah_kartu > BATAS_WAJAR_PER_HARI) {
    const sisa = db.hitungSisaProgressUser(konteks.jid);
    return {
      sukses: false,
      target_juz_per_hari: user.target_juz_per_hari || 'belum ditentukan',
      catatan_untuk_ai: `Angka yang dilaporkan user kelihatan tidak masuk akal (tidak jelas atau terlalu besar untuk satu hari). JANGAN dicatat. Tegur dengan lembut, minta user infokan ulang bacaannya dengan lebih jelas -- paling gampang sebut surat+ayat dari mana sampai mana -- dan sebutkan targetnya biar ada acuan: 1 juz per ${user.target_juz_per_hari || '?'} hari. JANGAN menyebut angka kartu/halaman.`,
    };
  }

  // Fix: cek TOTAL akumulasi hari ini (termasuk laporan sebelumnya hari yang sama)
  // supaya user tidak bisa lapor banyak berkali-kali jadi ratusan dalam sehari.
  const hariIniISO = db.tanggalHariIniISO();
  const logHariIni = db.getLogBacaanHarianByTanggal(konteks.jid, hariIniISO);
  const sudahDilaporkanHariIni = logHariIni?.jumlah_kartu || 0;
  const totalSetelahIni = sudahDilaporkanHariIni + jumlah_kartu;

  if (totalSetelahIni > BATAS_WAJAR_PER_HARI) {
    return {
      sukses: false,
      catatan_untuk_ai: 'Digabung dengan laporan user sebelumnya hari ini, total bacaannya kelihatan tidak masuk akal untuk satu hari. JANGAN dicatat. Tegur dengan lembut, tanya ulang apakah ini laporan susulan dari hari lain (bukan hari ini) atau memang ada salah sebut. JANGAN menyebut angka kartu/halaman.',
    };
  }

  db.catatLaporanBacaanManual(konteks.jid, hariIniISO, jumlah_kartu);
  db.setTanggalTerakhirBaca(konteks.jid, hariIniISO);
  // Tanpa ini user yang cuma lapor manual dianggap "tanpa target" (persen rekap tidak terhitung).
  db.pastikanTanggalMulaiBaca(konteks.jid, hariIniISO);
  db.resetNoResponse(konteks.jid);

  const sisa = db.hitungSisaProgressUser(konteks.jid);
  const catatanModeKartu = modeKartu && !konteks.dariGrup
    ? ' CATATAN TAMBAHAN: user ini masih mode KARTU (bukan reminder), tapi baru saja lapor manual seperti mode reminder. Setelah apresiasi progress, sebutkan dengan santai bahwa dia sebenarnya masih dalam mode kartu (jadi nanti tetap akan dikirimi gambar kartu juga), dan tawarkan (bukan paksa) apakah mau sekalian pindah ke mode reminder teks biar gak dobel sama laporan manualnya -- bilang "kartu gausah dulu"/"reminder aja" kalau mau pindah. Kalau dia tidak merespons soal ini atau menolak, tidak apa-apa, tetap lanjut seperti biasa.'
    : '';

  return {
    sukses: true,
    persen_target_hari_ini: sisa.persen_target_hari_ini ?? null,
    status_pace: sisa.status,
    selisih_dari_target: sisa.selisih_tampilan,
    gap_hari_tanpa_lapor: gapHari,
    mode_saat_ini: modeKartu ? 'kartu' : 'reminder',
    catatan_untuk_ai: (gapHari !== null && gapHari >= 2
      ? `Laporan berhasil dicatat. PENTING: user baru lapor lagi setelah ${gapHari} hari tidak ada laporan sama sekali. Sebelum/sesudah apresiasi progress hari ini, tanyakan dengan natural dan tanpa menghakimi apakah beberapa hari kemarin sempat baca juga (dari app/mushaf lain) tapi belum sempat lapor, atau memang belum sempat tilawah -- biar progressnya tetap akurat.`
      : 'Laporan berhasil dicatat. Apresiasi singkat, sebutkan progress terhadap target hari ini dalam PERSEN APA ADANYA (jangan hitung ulang sendiri, jangan sebut angka kartu/halaman).') + catatanModeKartu,
  };
}

async function eksekusiLaporBacaanByAyat({ nama_surat, nomor_ayat: nomorAyatMentah, dari_nama_surat, dari_nomor_ayat: dariAyatMentah }, konteks) {
  const nomor_ayat = Math.trunc(Number(nomorAyatMentah)); // LLM kadang mengirim string
  const user = db.getUser(konteks.jid);
  const modeKartu = user.bentuk_bacaan !== 'reminder';
  const gapHari = hitungGapHariTanpaLapor(konteks.jid);

  // Posisi SEBELUM lapor ini -- dipakai buat validasi arah & kasih konteks "dari...ke..." ke AI.
  const posisiSebelumnya = db.getBacaanByUrutan(user.last_sent_bacaan_id);

  const bacaanDitemukan = db.cariBacaanBySuratDanAyat(nama_surat, nomor_ayat);
  if (!bacaanDitemukan) {
    return {
      sukses: false,
      pesan: `Tidak ditemukan card yang mengandung "${nama_surat}" ayat ${nomor_ayat}.`,
      catatan_untuk_ai: `Data belum tersedia untuk ayat spesifik ini (kemungkinan data belum lengkap di sistem). Minta maaf dengan lembut, tawarkan dia lapor pakai perkiraan jumlah kartu saja (tool lapor_bacaan_manual) sebagai alternatif.`,
    };
  }

  // Titik MULAI bacaan (opsional): user bilang "dari surat A ayat x sampai surat B ayat y". Dengan titik
  // mulai, jumlah kartu yang dibaca dihitung dari rentang itu (dalam kartu), bukan dari posisi terakhir.
  let bacaanAwal = null;
  const adaTitikMulai = typeof dari_nama_surat === 'string' && dari_nama_surat.trim() !== '';
  if (adaTitikMulai) {
    const dariAyat = Math.trunc(Number(dariAyatMentah));
    bacaanAwal = Number.isFinite(dariAyat) ? db.cariBacaanBySuratDanAyat(dari_nama_surat, dariAyat) : null;
    if (!bacaanAwal) {
      return {
        sukses: false,
        pesan: `Tidak ditemukan card yang mengandung titik mulai "${dari_nama_surat}" ayat ${dariAyatMentah}.`,
        catatan_untuk_ai: 'Titik mulai bacaan yang disebut tidak ditemukan. Minta maaf dengan lembut, tanyakan apakah nama surat/nomor ayat awalnya sudah benar, atau tawarkan lapor titik akhirnya saja.',
      };
    }
    if (bacaanAwal.urutan > bacaanDitemukan.urutan) {
      return {
        sukses: false,
        pesan: 'Titik mulai berada SETELAH titik akhir.',
        catatan_untuk_ai: `Titik mulai (${bacaanAwal.surat_ayat}) ada setelah titik akhir (${bacaanDitemukan.surat_ayat}) di urutan mushaf. JANGAN dicatat. Tanyakan dengan lembut apakah ada yang tertukar atau salah sebut.`,
      };
    }
  }

  // Deteksi lompatan ganjil: mundur jauh ATAU maju TERLALU jauh (>30 urutan/card ~ 1 juz lebih)
  // dalam satu laporan -- kemungkinan salah sebut ayat/surat. JANGAN langsung overwrite,
  // kasih kesempatan AI konfirmasi dulu ke user.
  const posisiLamaUrutan = posisiSebelumnya?.urutan || 0;
  const selisihUrutan = bacaanDitemukan.urutan - posisiLamaUrutan;
  const mundurSignifikan = selisihUrutan < -3; // toleransi kecil, bisa aja emang mau ulang ayat dikit
  // Kartu yang dikreditkan hari ini. Tanpa titik mulai: kartu yang maju dari posisi terakhir.
  // Dengan titik mulai: kartu dalam rentang yang BELUM terhitung (kartu sampai posisi terakhir tidak
  // dihitung dua kali, jadi mengulang laporan yang sama = kredit 0). Posisi pertama kali (belum ada
  // pembanding) dihitung 1 kartu, atau seluruh rentang kalau titik mulainya disebut.
  let jumlahKartuBaru;
  if (bacaanAwal) {
    const batasSudahTerhitung = posisiSebelumnya ? Math.max(bacaanAwal.urutan - 1, posisiLamaUrutan) : bacaanAwal.urutan - 1;
    jumlahKartuBaru = Math.max(0, bacaanDitemukan.urutan - batasSudahTerhitung);
  } else {
    jumlahKartuBaru = !posisiSebelumnya ? 1 : Math.max(0, selisihUrutan);
  }
  // Batas "terlalu jauh" = kira-kira lebih dari 1 juz (rata-rata kartu per juz) dalam sekali lapor.
  // Dengan titik mulai yang dihitung adalah kartu yang dibaca, bukan jarak dari posisi lama
  // (user boleh membaca di luar Dawam lalu lompat posisi).
  const ukuranLompat = bacaanAwal ? jumlahKartuBaru : selisihUrutan;
  const majuTerlaluJauh = ukuranLompat > Math.max(10, Math.round(db.rataKartuPerJuz()));

  if ((mundurSignifikan || majuTerlaluJauh) && posisiSebelumnya &&
      !sudahDikonfirmasi(laporMenunggu, konteks.jid, bacaanDitemukan.urutan, konteks.giliranId)) {
    return {
      sukses: false,
      butuh_konfirmasi: true,
      posisi_sebelumnya: posisiSebelumnya.surat_ayat,
      posisi_yang_dilaporkan: bacaanDitemukan.surat_ayat,
      catatan_untuk_ai: mundurSignifikan
        ? `User sebelumnya di posisi "${posisiSebelumnya.surat_ayat}", tapi laporan baru ini (${bacaanDitemukan.surat_ayat}) keliatan MUNDUR jauh dari situ. JANGAN langsung catat. Tanya balik ke user dengan natural untuk konfirmasi -- apakah dia emang mau ulang baca dari situ, atau salah sebut ayat/surat. Kalau user sudah menjawab tegas bahwa benar, panggil ulang tool ini dengan argumen yang SAMA (jangan panggil lagi sebelum user menjawab).`
        : `User sebelumnya di posisi "${posisiSebelumnya.surat_ayat}", tapi laporan baru ini (${bacaanDitemukan.surat_ayat}) keliatan LONCAT TERLALU JAUH (lebih dari sekitar 1 juz dalam sekali lapor). JANGAN langsung catat. Tanya balik ke user dengan natural untuk konfirmasi, kali aja salah sebut nomor ayat atau emang udah baca banyak sekaligus. Kalau user sudah menjawab tegas bahwa benar, panggil ulang tool ini dengan argumen yang SAMA (jangan panggil lagi sebelum user menjawab).`,
    };
  }

  // Set posisi persis ke card yang ketemu (bukan +1 dari posisi lama) -- beda dengan
  // kirim_bacaan_lanjutan yang selalu nambah incremental.
  db.updateLastSentBacaanId(konteks.jid, bacaanDitemukan.urutan);

  // Kalau ayat yang dilaporkan ada di TENGAH kartu, kartu itu ditandai belum tuntas: kredit harian tetap
  // dihitung utuh (kartu = satuan), tapi "lanjut" berikutnya mengirim kartu yang sama lagi.
  const kartuTuntas = db.laporanMenuntaskanKartu(bacaanDitemukan, nama_surat, nomor_ayat);
  db.setKartuBelumTuntas(konteks.jid, kartuTuntas ? null : bacaanDitemukan.urutan);

  const hariIniISO = db.tanggalHariIniISO();
  db.setTanggalTerakhirBaca(konteks.jid, hariIniISO);
  db.pastikanTanggalMulaiBaca(konteks.jid, hariIniISO);
  db.resetNoResponse(konteks.jid);

  // Catat ke log harian supaya konsisten dengan hitungSisaProgressUser (persen_pace hari
  // ini dihitung dari jumlah_kartu di log_bacaan_harian). jumlahKartuBaru dihitung di atas.
  // Tidak maju (ulang ayat yang sama / mundur sedikit) = kredit 0, supaya mengulang laporan yang
  // sama tidak menaikkan persen harian.
  db.catatLogBacaanHarian(konteks.jid, hariIniISO, bacaanDitemukan.urutan, bacaanDitemukan.surat_ayat, null, jumlahKartuBaru);

  const sisa = db.hitungSisaProgressUser(konteks.jid);
  const catatanModeKartu = modeKartu && !konteks.dariGrup
    ? ' CATATAN TAMBAHAN: user ini masih mode KARTU (bukan reminder), tapi baru saja lapor manual by-ayat. Setelah apresiasi progress, sebutkan dengan santai bahwa dia sebenarnya masih dalam mode kartu, dan tawarkan (bukan paksa) apakah mau sekalian pindah ke mode reminder teks biar gak dobel sama laporan manualnya. Kalau tidak direspons/ditolak, tidak apa-apa.'
    : '';

  return {
    sukses: true,
    posisi_sebelumnya: posisiSebelumnya?.surat_ayat || null,
    posisi_baru: bacaanDitemukan.surat_ayat,
    posisi_mulai: bacaanAwal ? bacaanAwal.surat_ayat : null,
    persen_target_hari_ini: sisa.persen_target_hari_ini ?? null,
    kartu_berikutnya_melanjutkan_kartu_ini: !kartuTuntas,
    status_pace: sisa.status,
    selisih_dari_target: sisa.selisih_tampilan,
    gap_hari_tanpa_lapor: gapHari,
    mode_saat_ini: modeKartu ? 'kartu' : 'reminder',
    catatan_untuk_ai: (gapHari !== null && gapHari >= 2
      ? `Posisi berhasil disinkronkan dari "${posisiSebelumnya?.surat_ayat || 'belum ada posisi sebelumnya'}" ke "${bacaanDitemukan.surat_ayat}". PENTING: user baru lapor lagi setelah ${gapHari} hari tidak ada laporan. Tanyakan natural tanpa menghakimi apakah beberapa hari kemarin sempat baca juga tapi belum lapor. Sebutkan juga progress konkret (dari...ke...) dan status terhadap target hari ini apa adanya.`
      : `Posisi berhasil disinkronkan dari "${posisiSebelumnya?.surat_ayat || 'belum ada posisi sebelumnya'}" ke "${bacaanDitemukan.surat_ayat}". Sebutkan progress ini dengan konkret (dari...ke...), apresiasi singkat, dan sebutkan progress terhadap target hari ini dalam PERSEN APA ADANYA (jangan hitung ulang sendiri, jangan sebut angka kartu/halaman).`) + (kartuTuntas ? '' : ' Karena ayat terakhir yang dilaporkan ada di tengah kartu, kalau nanti user minta lanjut, Dawam akan mengirim kartu yang sama lagi supaya sisanya bisa dituntaskan -- sebutkan itu sekilas kalau pas.') + catatanModeKartu,
  };
}

async function eksekusiKoreksiCatatanBacaan({ jenis_koreksi, nama_surat, nomor_ayat, tanggal_relatif, alasan_koreksi, dari_nama_surat, dari_nomor_ayat: dariAyatMentah, jumlah_kartu }, konteks) {
  const bacaanDitemukan = db.cariBacaanBySuratDanAyat(nama_surat, nomor_ayat);
  if (!bacaanDitemukan) {
    return {
      sukses: false,
      pesan: `Tidak ditemukan card yang mengandung "${nama_surat}" ayat ${nomor_ayat}.`,
      catatan_untuk_ai: 'Data tidak ditemukan untuk ayat ini. Minta maaf dengan lembut, tanyakan apakah user yakin dengan nama surat/nomor ayatnya, atau tawarkan sebut rentang lain yang lebih pas.',
    };
  }

  // Koreksi JUMLAH KARTU hari itu (hanya log_tanggal_tertentu). Ini koreksi eksplisit dari user, jadi
  // MENIMPA total kartu tanggal itu (bukan menambah, dan tidak kena aturan anti-hitung-dobel laporan biasa).
  // Dua cara: sebut titik mulai (jumlah = kartu dari titik mulai sampai titik akhir, inklusif) atau
  // sebut jumlah_kartu langsung. Tanpa keduanya, koreksi hanya menimpa label/posisi (perilaku lama).
  let jumlahKartuTimpa = null;
  let bacaanAwal = null;
  if (jenis_koreksi === 'log_tanggal_tertentu') {
    const BATAS_KARTU_PER_HARI = Math.round(db.kartuPerHalaman() * 60);
    if (typeof dari_nama_surat === 'string' && dari_nama_surat.trim() !== '') {
      const dariAyat = Math.trunc(Number(dariAyatMentah));
      bacaanAwal = Number.isFinite(dariAyat) ? db.cariBacaanBySuratDanAyat(dari_nama_surat, dariAyat) : null;
      if (!bacaanAwal) {
        return {
          sukses: false,
          pesan: `Tidak ditemukan card yang mengandung titik mulai "${dari_nama_surat}" ayat ${dariAyatMentah}.`,
          catatan_untuk_ai: 'Titik mulai yang disebut tidak ditemukan. Minta maaf dengan lembut dan tanyakan apakah nama surat/nomor ayat awalnya sudah benar.',
        };
      }
      if (bacaanAwal.urutan > bacaanDitemukan.urutan) {
        return {
          sukses: false,
          pesan: 'Titik mulai berada SETELAH titik akhir.',
          catatan_untuk_ai: `Titik mulai (${bacaanAwal.surat_ayat}) ada setelah titik akhir (${bacaanDitemukan.surat_ayat}) di urutan mushaf. JANGAN dikoreksi dulu; tanyakan dengan lembut apakah ada yang tertukar.`,
        };
      }
      jumlahKartuTimpa = bacaanDitemukan.urutan - bacaanAwal.urutan + 1;
    } else if (jumlah_kartu !== undefined && jumlah_kartu !== null && jumlah_kartu !== '') {
      jumlahKartuTimpa = Math.round(Number(jumlah_kartu));
      if (!Number.isFinite(jumlahKartuTimpa) || jumlahKartuTimpa < 0) {
        return { sukses: false, pesan: 'jumlah_kartu tidak valid.', catatan_untuk_ai: 'Angka jumlah kartu dari user tidak jelas. Tanyakan ulang dengan lembut berapa kartu yang sebenarnya dia baca.' };
      }
    }
    if (jumlahKartuTimpa !== null && jumlahKartuTimpa > BATAS_KARTU_PER_HARI) {
      return {
        sukses: false,
        pesan: 'Jumlah bacaan yang disebut melebihi batas wajar satu hari.',
        catatan_untuk_ai: 'Bacaan sebanyak itu untuk satu hari kelihatan tidak masuk akal. JANGAN dikoreksi; tanyakan dengan lembut apakah ada salah sebut titik mulai/akhir atau ini gabungan beberapa hari. JANGAN menyebut angka kartu/halaman.',
      };
    }
  }

  // Koreksi yang memindahkan POSISI jauh butuh konfirmasi kedua (lihat koreksiMenunggu).
  const mempengaruhiPosisi =
    jenis_koreksi === 'posisi_sekarang' ||
    (jenis_koreksi === 'log_tanggal_tertentu' && tanggal_relatif === 'hari_ini');
  if (mempengaruhiPosisi) {
    const posisiSaatIni = db.getUser(konteks.jid).last_sent_bacaan_id || 0;
    const lompat = Math.abs(bacaanDitemukan.urutan - posisiSaatIni);
    const batasLompat = Math.round(db.rataKartuPerJuz()); // ~1 juz
    if (posisiSaatIni > 0 && lompat > batasLompat) {
      if (!sudahDikonfirmasi(koreksiMenunggu, konteks.jid, bacaanDitemukan.urutan, konteks.giliranId)) {
        const posisiLama = db.getBacaanByUrutan(posisiSaatIni);
        return {
          sukses: false,
          butuh_konfirmasi: true,
          posisi_sekarang: posisiLama?.surat_ayat || null,
          posisi_diminta: bacaanDitemukan.surat_ayat,
          catatan_untuk_ai: `Koreksi ini memindahkan posisi bacaan user SANGAT JAUH (dari "${posisiLama?.surat_ayat}" ke "${bacaanDitemukan.surat_ayat}", sekitar ${lompat} kartu) dan BELUM dilakukan. Tanyakan sekali lagi dengan jelas apakah memang posisinya mau dipindah ke situ (bukan salah sebut surat/ayat), dan JANGAN memanggil tool ini lagi sebelum user menjawab tegas. Kalau user menjawab tegas ya, panggil ulang dengan argumen yang SAMA.`,
        };
      }
    }
  }

  // Jejak audit sederhana -- biar kalau ada yang aneh belakangan, bisa ditelusuri siapa
  // yang minta koreksi apa dan kapan. Reuse tabel group_activity_log walau ini personal,
  // dengan jenis khusus biar bisa dibedakan nanti.
  db.catatAktivitasGroup(konteks.jid, konteks.jid, 'KOREKSI_MANUAL', `${jenis_koreksi}: ${alasan_koreksi} -> ${bacaanDitemukan.surat_ayat}`);

  if (jenis_koreksi === 'posisi_sekarang') {
    const posisiSebelumnya = db.getBacaanByUrutan(db.getUser(konteks.jid).last_sent_bacaan_id);
    db.updateLastSentBacaanId(konteks.jid, bacaanDitemukan.urutan);
    db.setKartuBelumTuntas(konteks.jid, null);

    return {
      sukses: true,
      posisi_lama: posisiSebelumnya?.surat_ayat || null,
      posisi_baru: bacaanDitemukan.surat_ayat,
      catatan_untuk_ai: `Posisi bacaan user berhasil dikoreksi dari "${posisiSebelumnya?.surat_ayat || 'belum ada'}" ke "${bacaanDitemukan.surat_ayat}". Konfirmasi ke user dengan hangat bahwa sudah dibetulkan.`,
    };
  }

  if (jenis_koreksi === 'log_tanggal_tertentu') {
    if (!tanggal_relatif) {
      return { sukses: false, pesan: 'tanggal_relatif wajib diisi untuk koreksi log tanggal tertentu.' };
    }
    const mapHari = { hari_ini: 0, kemarin: 1, dua_hari_lalu: 2, tiga_hari_lalu: 3 };
    const mundur = mapHari[tanggal_relatif] ?? 0;
    const tanggalISO = db.tanggalMundurISO(mundur);

    // Koreksi = TIMPA label/posisi catatan tanggal itu (dulu malah menambah +1 kartu). Kalau user
    // menyebut titik mulai atau jumlah kartu, total kartu tanggal itu ikut ditimpa.
    db.setLogBacaanHarian(konteks.jid, tanggalISO, bacaanDitemukan.urutan, bacaanDitemukan.surat_ayat, {
      jumlahKartu: jumlahKartuTimpa,
      bacaanIdAwal: bacaanAwal ? bacaanAwal.urutan : null,
    });
    // Kalau hari ini diberi total kartu > 0 lewat koreksi, tandai juga sudah baca hari ini.
    if (jumlahKartuTimpa !== null && jumlahKartuTimpa > 0 && mundur === 0) {
      db.setTanggalTerakhirBaca(konteks.jid, tanggalISO);
      db.pastikanTanggalMulaiBaca(konteks.jid, tanggalISO);
    }

    // Kalau yang dikoreksi adalah tanggal hari ini, sinkronkan juga posisi utamanya.
    if (mundur === 0) {
      db.updateLastSentBacaanId(konteks.jid, bacaanDitemukan.urutan);
      db.setKartuBelumTuntas(konteks.jid, null);
    }

    return {
      sukses: true,
      tanggal_dikoreksi: tanggalISO,
      posisi_baru: bacaanDitemukan.surat_ayat,
      posisi_mulai: bacaanAwal ? bacaanAwal.surat_ayat : null,
      persen_target_hari_ini: mundur === 0 ? (db.hitungSisaProgressUser(konteks.jid).persen_target_hari_ini ?? null) : null,
      catatan_untuk_ai: `Catatan tanggal ${tanggalISO} berhasil dikoreksi jadi "${bacaanDitemukan.surat_ayat}"${jumlahKartuTimpa !== null ? ', dan jumlah bacaan tanggal itu sudah ditimpa dengan yang benar' : ''}. Konfirmasi ke user dengan hangat bahwa sudah dibetulkan${mundur === 0 ? ' dan sebutkan capaian hari ini dalam PERSEN dari persen_target_hari_ini' : ''} (jangan sebut angka kartu/halaman).`,
    };
  }

  return { sukses: false, pesan: 'jenis_koreksi tidak dikenali.' };
}

// Cek apakah ada gap > 1 hari sejak terakhir kali user tercatat baca -- dipakai buat
// kasih AI konteks supaya nyapa natural ("beberapa hari ini gimana?") alih-alih diam.
function hitungGapHariTanpaLapor(jid) {
  const user = db.getUser(jid);
  if (!user.tanggal_terakhir_baca) return null;

  const selisihHari = db.selisihHariISO(user.tanggal_terakhir_baca, db.tanggalHariIniISO());
  return selisihHari; // 0 = hari ini juga udah lapor, 1 = kemarin terakhir, dst.
}
async function eksekusiGetProgressUser(_, konteks) {
  const user = db.getUser(konteks.jid);
  const bacaan = db.getBacaanByUrutan(user.last_sent_bacaan_id);
  const sisaProgress = db.hitungSisaProgressUser(konteks.jid);
  return {
    sukses: true,
    posisi_terakhir: bacaan?.surat_ayat || 'belum mulai membaca',
    juz_sekarang: bacaan?.juz ?? null,
    persen_progres_keseluruhan: sisaProgress.persen_progres_keseluruhan,
    persen_target_hari_ini: sisaProgress.persen_target_hari_ini ?? null,
    target_hari_per_juz: user.target_juz_per_hari || 'belum ditentukan',
    hari_berjalan: db.hitungHariBerjalanUser(konteks.jid),
    mode_saat_ini: user.mode_baca_arab_saja === 1 ? 'arab' : 'terjemah-saja (halangan)',
    status_pace: sisaProgress.status || null,
    selisih_dari_target: sisaProgress.selisih_tampilan || null,
    catatan_untuk_ai: 'posisi_terakhir/juz_sekarang cuma LOKASI baca (bisa jadi user memang mulai dari situ, bukan berarti progress banyak). Progress SEBENARNYA: persen_progres_keseluruhan (persen menuju khatam sejak mulai), persen_target_hari_ini (capaian hari ini) dan selisih_dari_target (sudah final, pakai apa adanya, JANGAN dihitung ulang). Sebut progres HANYA dalam persen, jangan sebut angka kartu/halaman.',
  };
}

async function eksekusiGetInfoMushaf(_, konteks) {
  const totalKartu = db.countBacaan();
  const daftarPerJuz = [];
  for (let juz = 1; juz <= 30; juz++) {
    daftarPerJuz.push({ juz, jumlah_kartu: db.hitungJumlahKartuDalamJuz(juz) });
  }

  return {
    sukses: true,
    total_kartu_keseluruhan: totalKartu,
    jumlah_kartu_per_juz: daftarPerJuz,
    catatan_untuk_ai: 'Data ini FINAL dan akurat dari database, pakai apa adanya. Jumlah kartu per juz BERBEDA-BEDA (tidak rata 30/juz) karena ngikutin panjang-pendeknya ayat di skema Mushaf Madinah -- JANGAN asumsikan rata/sama, JANGAN menghitung sendiri, JANGAN membulatkan. Kalau user tanya soal juz tertentu, cari angkanya di jumlah_kartu_per_juz sesuai nomor juz yang ditanya.',
  };
}

async function eksekusiSetPosisiBacaan({ nama_surat }, konteks) {
  const bacaan = db.cariBacaanBySuratLike(nama_surat);
  if (!bacaan) {
    return { sukses: false, pesan: `Surat "${nama_surat}" tidak ditemukan di data bacaan.` };
  }
  db.updateLastSentBacaanId(konteks.jid, bacaan.urutan - 1);
  db.setKartuBelumTuntas(konteks.jid, null);
  db.setStartBacaanId(konteks.jid, bacaan.urutan - 1);
  return {
    sukses: true,
    surat_ayat: bacaan.surat_ayat,
    catatan_untuk_ai: `Posisi bacaan user dipindah ke sekitar ${bacaan.surat_ayat}. Bacaan berikutnya yang dikirim akan mulai dari sini, dan progress/pace dihitung ulang dari titik ini.`,
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
  db.setSudahLaporSesiIni(konteks.jid, true);
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

async function eksekusiAturFiturDawam(args, konteks) {
  const fieldDiubah = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== null);
  if (fieldDiubah.length === 0) {
    return { sukses: false, pesan: 'Tidak ada pengaturan yang diubah.' };
  }
  const dataUntukDb = { ...args };
  for (const k of ['reminder_sholat_aktif', 'tawaran_tilawah_aktif', 'tawaran_alkahfi_aktif', 'reminder_jumat_laki_aktif']) {
    if (typeof dataUntukDb[k] === 'boolean') dataUntukDb[k] = dataUntukDb[k] ? 1 : 0;
  }
  db.updateUserFields(konteks.jid, dataUntukDb);
  return {
    sukses: true,
    field_diubah: fieldDiubah,
    catatan_untuk_ai: 'Pengaturan berhasil diubah. Konfirmasi singkat ke user apa yang baru saja dimatikan/dinyalakan/diubah.',
  };
}

async function eksekusiGetPengaturanUser(_, konteks) {
  const user = db.getUser(konteks.jid);
  const emoji = (aktif) => (aktif ? '✅' : '❌');

  const baris = [
    `${emoji(user.reminder_sholat_aktif !== 0)} Reminder sholat 5 waktu: ${user.reminder_sholat_aktif !== 0 ? 'aktif' : 'nonaktif'}`,
    `${emoji(user.tawaran_tilawah_aktif !== 0)} Tawaran tilawah: ${user.tawaran_tilawah_aktif !== 0 ? `aktif${user.bentuk_bacaan === 'reminder' ? ' (versi teks, tanpa kartu gambar)' : ' (kirim kartu gambar)'}` : 'nonaktif'}`,
    `${emoji(user.tawaran_alkahfi_aktif !== 0)} Tawaran Al-Kahfi (Jumat): ${user.tawaran_alkahfi_aktif !== 0 ? 'aktif' : 'nonaktif'}`,
  ];
  if (user.gender === 'L') {
    baris.push(`${emoji(user.reminder_jumat_laki_aktif !== 0)} Reminder Jumat laki-laki: ${user.reminder_jumat_laki_aktif !== 0 ? 'aktif' : 'nonaktif'}`);
  }

  return {
    sukses: true,
    teks_pengaturan: baris.join('\n'),
    catatan_untuk_ai: 'Kirim field teks_pengaturan PERSIS APA ADANYA (list yang sudah jadi), boleh tambah 1 kalimat pembuka singkat sebelum list dan tawaran mau ubah apa di akhir, TAPI JANGAN mengubah/menyusun ulang isi list itu sendiri.',
  };
}

async function eksekusiTanyaBacaanHariLain({ tanggal_relatif }, konteks) {
  const mapHari = { kemarin: 1, dua_hari_lalu: 2, tiga_hari_lalu: 3 };
  const mundur = mapHari[tanggal_relatif] || 1;
  const tanggalISO = db.tanggalMundurISO(mundur);

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
  if (cekCooldown(`broadcast:${konteks.jid}`, COOLDOWN_BROADCAST_MS) > 0) {
    return {
      sukses: false,
      pesan: 'Baru saja mengirim ke grup.',
      catatan_untuk_ai: 'User baru saja kirim pesan ke grup beberapa saat lalu. Minta dia tunggu sebentar sebelum kirim lagi supaya grup tidak kebanjiran.',
    };
  }
  const terkirim = await konteks.kirimKeGrup(user.group_sosial_jid, `${namaPengirim}: ${isi_pesan}`);

  if (!terkirim) {
    return { sukses: false, pesan: 'Gagal mengirim pesan ke grup.' };
  }
  tandaiCooldown(`broadcast:${konteks.jid}`);

  db.catatAktivitasGroup(user.group_sosial_jid, konteks.jid, 'BROADCAST_PERSONAL', isi_pesan.slice(0, 200));

  return { sukses: true, catatan_untuk_ai: 'Pesan berhasil dikirim ke grup sosial. Beri tahu user singkat bahwa sudah terkirim.' };
}

// ---- Power user: feedback ke tim ----

const LABEL_STATUS_FEEDBACK = {
  PENDING: 'menunggu diteruskan ke tim',
  TERKIRIM: 'sudah diteruskan ke tim, belum dikerjakan',
  SELESAI: 'sudah dikerjakan',
};

function tolakBukanPowerUser() {
  return {
    sukses: false,
    pesan: 'User ini bukan Power User.',
    catatan_untuk_ai: 'Fitur feedback ke tim hanya untuk Power User. Jangan menjanjikan masukan ini akan sampai ke tim. Tanggapi natural, boleh bilang idenya bagus dan akan ditampung, tanpa janji apapun.',
  };
}

async function eksekusiKirimFeedbackDawam({ isi, kategori }, konteks) {
  if (!power.isPowerUser(konteks.jid)) return tolakBukanPowerUser();

  const teks = String(isi ?? '').trim();
  if (teks.length < 8) {
    return { sukses: false, pesan: 'Isi masukan terlalu singkat.', catatan_untuk_ai: 'Isi masukannya belum cukup jelas untuk dicatat. Tanya user dengan natural apa yang terjadi / apa yang dia harapkan, baru catat setelah jelas.' };
  }
  if (teks.length > power.BATAS_PANJANG_FEEDBACK) {
    return { sukses: false, pesan: 'Isi masukan terlalu panjang.', catatan_untuk_ai: `Isi masukan melebihi ${power.BATAS_PANJANG_FEEDBACK} karakter. Ringkas dulu intinya (tetap pertahankan detail penting) lalu panggil ulang.` };
  }

  const sama = db.cariFeedbackPendingSama(konteks.jid, teks);
  if (sama) {
    return { sukses: true, id: sama, sudah_ada: true, catatan_untuk_ai: `Masukan yang sama persis sudah tercatat sebagai #${sama}. Beri tahu user itu sudah tercatat, jangan dicatat ulang.` };
  }

  if (db.hitungFeedbackPowerHariIni(konteks.jid) >= power.BATAS_FEEDBACK_PER_HARI) {
    return { sukses: false, pesan: 'Batas harian tercapai.', catatan_untuk_ai: `User sudah mengirim ${power.BATAS_FEEDBACK_PER_HARI} masukan hari ini, batas harian tercapai. Sampaikan dengan lembut, minta lanjut besok, dan terima kasih atas semangatnya.` };
  }

  const id = db.simpanFeedbackPower(konteks.jid, teks, kategori);
  return {
    sukses: true,
    id,
    kategori: db.KATEGORI_FEEDBACK.includes(kategori) ? kategori : 'LAIN',
    catatan_untuk_ai: `Tercatat sebagai feedback #${id}. Sebutkan singkat apa yang dicatat beserta nomor #${id}, bilang masukan dikumpulkan lalu diteruskan ke tim, dan dia akan dikabari kalau sudah dikerjakan. JANGAN menjanjikan kapan atau apakah pasti dikerjakan.`,
  };
}

async function eksekusiUbahFeedbackDawam({ id, isi_baru, kategori }, konteks) {
  if (!power.isPowerUser(konteks.jid)) return tolakBukanPowerUser();

  const nomor = Math.trunc(Number(id));
  const teks = String(isi_baru ?? '').trim();
  if (teks.length < 8 || teks.length > power.BATAS_PANJANG_FEEDBACK) {
    return { sukses: false, pesan: 'Isi baru tidak valid.', catatan_untuk_ai: `Isi feedback harus 8 sampai ${power.BATAS_PANJANG_FEEDBACK} karakter dan lengkap. Perbaiki lalu panggil ulang, atau tanya user.` };
  }

  if (db.ubahFeedbackPending(nomor, konteks.jid, teks, kategori)) {
    return { sukses: true, id: nomor, catatan_untuk_ai: `Feedback #${nomor} berhasil diperbarui. Konfirmasi singkat ke user.` };
  }

  const ada = db.getFeedbackPower(nomor);
  if (!ada || ada.user_jid !== konteks.jid) {
    return { sukses: false, pesan: 'Feedback tidak ditemukan.', catatan_untuk_ai: `Tidak ada feedback #${nomor} milik user ini. Cek nomornya lewat get_feedback_saya kalau perlu.` };
  }
  return {
    sukses: false,
    pesan: 'Feedback sudah diteruskan ke tim.',
    catatan_untuk_ai: `Feedback #${nomor} sudah diteruskan ke tim jadi tidak bisa diubah lagi. Tawarkan untuk mencatat tambahan/koreksinya sebagai feedback baru lewat kirim_feedback_dawam (sebut bahwa ini lanjutan dari #${nomor}).`,
  };
}

async function eksekusiGetFeedbackSaya(_, konteks) {
  if (!power.isPowerUser(konteks.jid)) return tolakBukanPowerUser();
  const daftar = db.getFeedbackPowerUser(konteks.jid, 10);
  if (daftar.length === 0) {
    return { sukses: true, jumlah: 0, catatan_untuk_ai: 'User ini belum pernah mengirim feedback.' };
  }
  return {
    sukses: true,
    jumlah: daftar.length,
    feedback: daftar.map((f) => ({
      id: f.id,
      tanggal: f.tanggal,
      kategori: f.kategori,
      isi: f.isi_asli.length > 200 ? `${f.isi_asli.slice(0, 200)}...` : f.isi_asli,
      status: LABEL_STATUS_FEEDBACK[f.status] || f.status,
      catatan_tim: f.catatan_selesai || null,
    })),
    catatan_untuk_ai: 'Ringkas status feedback ini apa adanya sesuai field status. Jangan mengarang perkiraan waktu pengerjaan.',
  };
}

const EKSEKUTOR_PERSONAL = {
  kirim_feedback_dawam: eksekusiKirimFeedbackDawam,
  ubah_feedback_dawam: eksekusiUbahFeedbackDawam,
  get_feedback_saya: eksekusiGetFeedbackSaya,
  get_progress_user: eksekusiGetProgressUser,
  get_info_mushaf: eksekusiGetInfoMushaf,
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
  atur_fitur_dawam: eksekusiAturFiturDawam,
  get_pengaturan_user: eksekusiGetPengaturanUser,
  lapor_bacaan_manual: eksekusiLaporBacaanManual,
  lapor_bacaan_by_ayat: eksekusiLaporBacaanByAyat,
  koreksi_catatan_bacaan: eksekusiKoreksiCatatanBacaan,
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
  if (cekCooldown(`rekap:${konteks.groupJid}`, COOLDOWN_REKAP_MS) > 0) {
    return {
      sukses: false,
      pesan: 'Rekap harian baru saja dikirim.',
      catatan_untuk_ai: 'Rekap harian baru saja dikirim ke grup (belum 10 menit). Bilang santai bahwa rekapnya barusan sudah ada di atas, jadi scroll saja dulu.',
    };
  }
  const hasil = await konteks.kirimRekapHarian(konteks.groupJid);
  if (hasil.terkirim) tandaiCooldown(`rekap:${konteks.groupJid}`);
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
  if (cekCooldown(`tag:${konteks.groupJid}`, COOLDOWN_TAG_MS) > 0) {
    return {
      sukses: false,
      pesan: 'Tag baru saja dikirim.',
      catatan_untuk_ai: 'Tag ke anggota baru saja dikirim ke grup beberapa menit lalu. Bilang santai agar tunggu sebentar supaya anggota tidak terganggu.',
    };
  }
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
  tandaiCooldown(`tag:${konteks.groupJid}`);
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

// Lapor bacaan dari dalam grup: dicatat ke akun PERSONAL si pengirim (konteks.senderJid),
// pakai logic yang sama persis dengan lapor di chat pribadi supaya masuk log harian + rekap.
function bungkusLaporDariGrup(eksekutorPersonal) {
  return async (args, konteks) => {
    const user = db.getUser(konteks.senderJid);
    if (!user || user.is_registered !== 1) {
      return {
        sukses: false,
        pesan: 'Pengirim belum aktivasi personal, jadi laporannya belum bisa dicatat.',
        catatan_untuk_ai: 'JANGAN bilang laporannya sudah tercatat. Tanggapi hangat, lalu ajak dia kirim kata "dawam" ke chat pribadi dulu biar progressnya bisa tercatat, baru lapor lagi.',
      };
    }
    return eksekutorPersonal(args, { ...konteks, jid: konteks.senderJid, dariGrup: true });
  };
}

const EKSEKUTOR_GRUP = {
  lapor_bacaan_manual: bungkusLaporDariGrup(eksekusiLaporBacaanManual),
  lapor_bacaan_by_ayat: bungkusLaporDariGrup(eksekusiLaporBacaanByAyat),
  get_rekap_progress_grup: eksekusiGetRekapProgressGrup,
  get_info_mushaf: eksekusiGetInfoMushaf,
  minta_rekap_harian: eksekusiMintaRekapHarian,
  tag_anggota_grup: eksekusiTagAnggotaGrup,
  set_grup_sosial_ini: eksekusiSetGrupSosialIni,
  klaim_card_kawan: eksekusiKlaimCardKawan,
};

module.exports = {
  TOOLS_PERSONAL,
  TOOLS_POWER,
  toolsPersonalUntuk,
  TOOLS_GRUP,
  EKSEKUTOR_PERSONAL,
  EKSEKUTOR_GRUP,
};