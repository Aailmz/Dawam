const OpenAI = require('openai');

// Timeout & retry dibatasi (lihat agent.js).
const groq = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: 90_000,
  maxRetries: 1,
});

const MODEL = process.env.AI_MODEL;

// Nilai bawaan onboarding ('-') berarti "user tidak menjawab" -- jangan dipakai sebagai isi.
const adaIsi = (v) => !!v && v !== '-';

// ========== SYSTEM PROMPT DASAR (karakter Dawam) ==========

const SYSTEM_PROMPT = `Kamu adalah "Dawam", asisten WhatsApp islami yang ramah dan hangat.
Tugasmu mengingatkan pengguna shalat 5 waktu dan menemani mereka tilawah Al-Qur'an harian.

Gaya bicaramu:
- Hangat, lembut, tidak menggurui, tidak kaku seperti robot
- Islami tapi natural, sesekali sisipkan ayat/hadits pendek yang relevan (opsional, jangan dipaksakan tiap pesan)
- Selalu panggil nama pengguna kalau nama diberikan
- Singkat, padat, tidak bertele-tele (ini WhatsApp, bukan artikel)
- Tidak menghakimi kalau pengguna menolak/menunda
- Gunakan emoji secukupnya, jangan berlebihan

ATURAN PENULISAN WAJIB (PELANGGARAN = FATAL):
- Tulis dengan kapitalisasi normal bahasa Indonesia: hanya huruf pertama kalimat dan nama diri yang kapital. DILARANG KERAS menulis Setiap Kata Diawali Huruf Besar (Title Case) seperti ini -- itu SALAH.
- DILARANG KERAS memakai tanda "—" (em dash) atau "--" (dua strip) di manapun dalam responsmu, untuk alasan apapun. Kalau butuh jeda/penekanan, pakai koma, titik, atau pecah jadi kalimat baru.
- Jangan pernah membalas dengan salam/sapaan seperti "Wa'alaikumsalam" atau "Assalamu'alaikum" KECUALI kamu diminta secara eksplisit membuat pesan pembuka/salam. Kamu adalah BOT yang MENGIRIM pesan ke user, bukan user yang membalas salam ke kamu.
- Jangan mengulang/menggemakan ucapan terima kasih atau sambutan dari pesan sebelumnya. Fokus HANYA pada instruksi yang diberikan di prompt saat ini, jangan membalas seolah menyambung percakapan lain yang tidak diminta.
- Jangan menyisipkan isi dari pesan lain atau instruksi lain yang tidak diminta. Hasilkan HANYA pesan sesuai permintaan spesifik di prompt user, tidak lebih.
- Selesaikan kalimat dengan lengkap, jangan terpotong di tengah.`;


// ========== GENERATE PESAN DINAMIS (existing, tidak berubah) ==========

async function generateReminderSholat(namaWaktu, namaUser) {
  const prompt = `Ini adalah pesan BARU yang kamu mulai sendiri (bukan balasan ke pesan user manapun). Buatkan SATU pesan singkat (maksimal 3-4 kalimat) untuk mengingatkan ${namaUser} bahwa waktu sholat ${namaWaktu} telah tiba.
Pesan ini BOLEH diawali salam "Assalamu'alaikum" karena ini pesan pembuka dari kamu, TAPI jangan membalas seolah merespons salam dari user (user tidak mengirim salam apapun).
Variasikan gaya bahasanya, jangan selalu sama persis tiap kali diminta.
Boleh sesekali selipkan potongan ayat Qur'an atau hadits pendek yang relevan dengan shalat, tapi tidak wajib di setiap pesan.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip, tanpa penjelasan tambahan.`;

  return await callGroqText(prompt, 300);
}

async function generateTawaranNgaji(namaUser) {
  const prompt = `Buatkan SATU pesan singkat (maksimal 3-4 kalimat) untuk menanyakan kepada ${namaUser} apakah dia siap melanjutkan tilawah Al-Qur'an hari ini, setelah sebelumnya diingatkan shalat.
Di akhir pesan, minta dia membalas dengan kata-kata sederhana seperti "ya" atau "nanti".
Variasikan gaya bahasanya tiap kali diminta, jangan selalu template yang sama.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip, tanpa penjelasan tambahan.`;

  return await callGroqText(prompt, 400);
}

/**
 * Versi khusus gender P: sisipkan info soal mode terjemah-saja untuk halangan (§6.2a).
 * Dipakai HANYA sekali, saat tawaran baca pertama kali dikirim ke user gender P.
 */
async function generateTawaranNgajiUntukP(namaUser) {
  const prompt = `Buatkan SATU pesan singkat (maksimal 4-5 kalimat) untuk menanyakan kepada ${namaUser} apakah dia siap melanjutkan tilawah Al-Qur'an hari ini, setelah sebelumnya diingatkan shalat.
Di akhir pesan, minta dia membalas dengan kata-kata sederhana seperti "ya" atau "nanti".
Sisipkan juga satu kalimat santai yang menjelaskan bahwa kalau suatu saat dia lagi halangan (haid) dan tidak sedang memegang mushaf, dia bisa bilang ke bot kapan saja dan bot akan kirimkan artinya saja.
Variasikan gaya bahasanya tiap kali diminta, jangan selalu template yang sama.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip, tanpa penjelasan tambahan.`;

  return await callGroqText(prompt);
}

async function generateResponYa(namaUser) {
  const prompt = `${namaUser} baru saja bilang "ya" (mau lanjut tilawah). Buatkan SATU kalimat pendek yang hangat dan menyemangati, SEBUTKAN namanya (${namaUser}) di kalimat itu, sebelum bot mengirimkan gambar bacaan Al-Qur'an.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

async function generateResponTidak(namaUser) {
  const prompt = `${namaUser} baru saja bilang "nanti"/belum siap untuk tilawah hari ini. Buatkan SATU pesan singkat yang hangat, tidak menghakimi, tetap menyemangati tanpa memaksa. SEBUTKAN namanya (${namaUser}) di pesan ini.
Boleh sesekali selipkan hadits pendek tentang istiqomah/konsistensi dalam amal walau sedikit, tapi tidak wajib.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

async function generateFallbackChat(namaUser, pesanUser) {
  const prompt = `${namaUser ? namaUser : 'Seseorang'} baru saja mengirim SATU pesan ini ke kamu (Dawam) di WhatsApp, di luar konteks flow yang biasa (bukan jawaban ya/nanti untuk ajakan tilawah):

"${pesanUser}"

Balas HANYA pesan di atas secara natural dan hangat sesuai karaktermu, sebagai balasan baru yang relevan dengan isi pesan tersebut. JANGAN mengulang, menggemakan, atau merujuk ke pesan-pesan sebelumnya di luar yang dikutip di atas -- anggap ini satu pesan berdiri sendiri. Jika pesannya berupa sapaan ringan, tanggapi singkat dan ramah. Jika tidak relevan sama sekali dengan ibadah, tetap balas sopan dan boleh arahkan kembali ke topik shalat/tilawah jika pas, tanpa memaksa.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt, 300);
}


// ========== FUNGSI BARU PHASE 2: GENERATE PESAN ==========



/**
 * Tawaran lanjut baca dalam sesi yang sama, untuk user dengan target 3/1 hari per juz (§4.3).
 */
async function generateTawaranLanjutSesi(namaUser, targetJuzPerHari) {
  const prompt = `${namaUser} punya target khatam 1 juz per ${targetJuzPerHari} hari, dan baru saja selesai membaca satu kartu bacaan. Berdasarkan progressnya, dia masih di bawah pace target untuk hari ini.
Buatkan SATU pesan singkat (2-3 kalimat) menyemangati dan menanyakan apakah dia mau lanjut membaca kartu berikutnya sekarang juga, atau cukup dulu untuk saat ini.
Minta dia membalas dengan kata sederhana seperti "ya"/"lanjut" atau "cukup"/"nanti".
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

/**
 * Pesan saat user SUDAH mencapai/melampaui pace target hari ini (lawan dari
 * generateTawaranLanjutSesi). Dikirim supaya user tidak dibiarkan diam tanpa kabar.
 */
async function generateSudahCapaiPace(namaUser, targetJuzPerHari) {
  const prompt = `${namaUser} baru saja selesai membaca, dan progressnya sudah mencapai atau melampaui target pace hari ini (target: 1 juz per ${targetJuzPerHari} hari, sekarang sudah 100% dari target harian).
Buatkan SATU pesan singkat (2-3 kalimat) yang hangat, memberi selamat/apresiasi jelas atas pencapaian 100% target hari ini, sebut namanya. PENTING: pastikan dia benar-benar tahu/sadar bahwa dia SUDAH mencapai target hari ini (jangan cuma tersirat, sebutkan eksplisit semacam "udah 100% target hari ini" atau "target hari ini udah kelar").
Setelah itu, tetap tanyakan apakah dia mau lanjut baca kartu berikutnya (bonus, di luar target) atau cukup dulu untuk sesi ini. JANGAN mengasumsikan dia mau berhenti -- ini cuma info + tawaran, bukan penutupan sesi.
Minta dia membalas dengan kata sederhana seperti "ya"/"lanjut" atau "cukup"/"nanti".
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt, 350);
}

/**
 * Penutup sesi singkat untuk target pace normal (6 hari/juz), setelah selesai baca/terjemah.
 */
async function generatePenutupSesiBiasa(namaUser) {
  const prompt = `${namaUser} baru saja selesai sesi tilawahnya untuk waktu sholat ini (pace normal, tidak ada target kecepatan khusus).
Buatkan SATU pesan penutup singkat (1-2 kalimat) yang hangat, sebut namanya, mengucapkan semoga menjadi amal baik, dan beri tahu akan ditemani lagi di waktu sholat berikutnya.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt, 250);
}

/**
 * Reminder balik ke target asli kalau user berhenti sebelum capai pace (§4.4).
 */
async function generateIngatkanTargetAsli(namaUser, targetJuzPerHari) {
  const prompt = `Ingatkan ${namaUser} dengan nada hangat, TIDAK menghakimi, bahwa target khatamnya adalah 1 juz per ${targetJuzPerHari} hari.
Ajak dia untuk coba kejar progress itu lagi di waktu sholat berikutnya. Jangan buat dia merasa bersalah.
Balas HANYA dengan isi pesannya saja (SATU pesan singkat, 2-3 kalimat), tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

/**
 * Tawaran mode terjemah-saja untuk halangan, dikirim saat mencapai 3x tidak baca
 * dan user gender P sedang dalam mode normal (§7.2).
 */
async function generateTawaranModeHalangan(namaUser) {
  const prompt = `Buatkan SATU pesan singkat (2-3 kalimat) yang lembut untuk ${namaUser}, menanyakan dengan halus apakah mungkin dia sedang berhalangan (haid) sehingga belum sempat tilawah beberapa kali terakhir.
Jelaskan kalau iya, dia bisa bilang saja ke bot dan nanti dikirimkan bacaan terjemahnya saja (tanpa perlu pegang mushaf Arab).
Nada harus sangat sopan dan tidak asumtif/memaksa, ini hanya tawaran.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

/**
 * Pesan setelah 3x berturut-turut tidak membaca, menyisipkan motivasi personal user (§7.2).
 */
async function generatePesanSetelah3xTidakBaca(namaUser, motivasiPersonal) {
  const motivasiText = adaIsi(motivasiPersonal)
    ? `'${motivasiPersonal}'`
    : `tidak ada catatan motivasi spesifik, jadi gunakan motivasi umum yang hangat`;

  const prompt = `${namaUser} sudah 3 kali berturut-turut belum sempat tilawah. Buatkan SATU pesan (3-4 kalimat) yang:
1. Menanyakan dengan lembut apa yang membuatnya belum sempat, TANPA menghakimi sama sekali.
2. Mengingatkan dia dengan motivasi personalnya sendiri, yaitu: ${motivasiText} -- gunakan ini sebagai pengingat hangat, BUKAN tekanan atau kalimat menyalahkan.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}


// ========== PARSING INTENT JAWABAN (existing, tidak berubah) ==========

async function parseIntentJawaban(pesanUser) {
  // Jalur cepat tanpa LLM: jawaban persis "ya"/"nanti" tidak perlu menunggu AI.
  const cepat = fallbackKeywordIntent(pesanUser);
  if (cepat !== 'TIDAK_JELAS') return cepat;

  const prompt = `Seorang pengguna ditanya apakah dia siap melanjutkan tilawah Al-Qur'an. Dia menjawab:

"${pesanUser}"

Klasifikasikan jawaban ini ke SALAH SATU dari tiga kategori berikut:
- YA (kalau dia setuju/mau/siap, dalam bentuk apapun termasuk informal seperti "boleh", "gas", "siap", emoji positif, dll)
- TIDAK (kalau dia menolak/menunda, seperti "nanti", "belum", "sibuk", "engga dulu", dll)
- TIDAK_JELAS (kalau jawabannya tidak bisa ditentukan, pertanyaan lain, atau sama sekali tidak relevan)

Balas HANYA dengan satu kata: YA, TIDAK, atau TIDAK_JELAS. Tanpa penjelasan tambahan.`;

  const hasil = await callGroqText(prompt, 100);

  if (!hasil) {
    console.log('⚠️  Groq gagal/kosong saat parsing intent, fallback ke keyword matching manual.');
    return fallbackKeywordIntent(pesanUser);
  }

  const cleaned = hasil.trim().toUpperCase();

  if (cleaned.includes('TIDAK_JELAS')) return 'TIDAK_JELAS';
  if (cleaned.includes('TIDAK')) return 'TIDAK';
  if (cleaned.includes('YA')) return 'YA';

  console.log(`⚠️  Groq balas di luar format yang diharapkan: "${hasil}", pakai fallback keyword.`);
  return fallbackKeywordIntent(pesanUser);
}


function fallbackKeywordIntent(pesanUser) {
  // Buang tanda baca/emoji supaya "Ya!", "iya." atau "gas 🙏" tetap terbaca.
  const text = String(pesanUser || '')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const jawabanYa = ['ya', 'yaa', 'iya', 'iyaa', 'mau', 'yes', 'y', 'boleh', 'siap', 'gas', 'oke', 'ok', 'sip', 'yuk', 'lanjut'];
  const jawabanTidak = ['nanti', 'nanti dulu', 'tidak', 'ga', 'gak', 'nggak', 'ngga', 'engga', 'enggak', 'no', 'belum', 'belum dulu'];

  if (jawabanYa.includes(text)) return 'YA';
  if (jawabanTidak.includes(text)) return 'TIDAK';
  return 'TIDAK_JELAS';
}

// ========== FUNGSI BARU PHASE 2: PARSING ==========



/**
 * Parse jawaban "mau mulai dari surat mana" jadi { surat, ayat } atau null (§3.1).
 * Structured output via JSON.
 */
async function parseSuratAyatDariJawaban(pesanUser) {
  const systemPromptJson = `Kamu adalah parser teks. Jawab HANYA dengan JSON valid, tanpa teks tambahan, tanpa markdown code fence.`;

  const userPrompt = `Seorang pengguna ditanya mau mulai tilawah dari surat/ayat apa. Dia menjawab:

"${pesanUser}"

Jika dia menyebutkan nama surat tertentu (dengan atau tanpa nomor ayat), balas JSON:
{"surat": "<nama surat, format kapital awal kata, contoh: Al-Baqarah>", "ayat": <nomor ayat sebagai integer, atau null kalau tidak disebutkan>}

Jika dia bilang "dari awal"/"Al-Fatihah"/tidak menyebutkan surat spesifik/jawabannya tidak jelas, balas:
{"surat": null, "ayat": null}`;

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPromptJson },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2800, // 400 sering habis oleh reasoning (finish_reason: length) -> hasil kosong
      temperature: 0.2,
    });

    const result = completion.choices[0]?.message?.content?.trim();
    if (!result) return { surat: null, ayat: null };

    const cleanedJson = result.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanedJson);
    return {
      surat: parsed.surat || null,
      ayat: typeof parsed.ayat === 'number' ? parsed.ayat : null,
    };
  } catch (err) {
    console.error('❌ Gagal parsing surat/ayat via Groq:', err.message);
    return { surat: null, ayat: null };
  }
}


/**
 * Extract SEMUA field onboarding yang bisa ditangkap dari satu pesan user,
 * partial-fill -- field yang tidak disebutkan tetap null (tidak menimpa data lama).
 */
async function extractDataOnboarding(pesanUser, fieldMasihKosong) {
  const systemPromptJson = `Kamu parser onboarding bot islami "Dawam". Jawab HANYA JSON valid, tanpa markdown fence.`;

  const userPrompt = `Field yang masih perlu diisi: ${fieldMasihKosong.join(', ')}.

Pesan user: "${pesanUser}"

Extract SEBANYAK MUNGKIN field berikut KALAU disebutkan/tersirat jelas di pesan (boleh lebih dari satu field sekaligus kalau user jawab gabungan):
- name: nama panggilan (rapikan Kapital Awal Kata)
- location: kota/daerah domisili (rapikan Kapital Awal Kata)
- gender: "L" (laki-laki/akhi) atau "P" (perempuan/ukhti)
- target_juz_per_hari: "6", "3", atau "1". PENTING soal satuan: angka ini artinya "1 JUZ PER BERAPA HARI", BUKAN jumlah juz per hari dan BUKAN total hari khatam keseluruhan. Jadi "6" = santai = butuh 6 hari untuk menyelesaikan 1 juz (paling lambat). "3" = sedang = 1 juz per 3 hari. "1" = cepat = 1 juz per hari (tercepat). Semakin BESAR angkanya, semakin SANTAI/LAMBAT temponya -- JANGAN disalahartikan jadi "semakin besar = semakin rajin/banyak juz per hari", itu TERBALIK.
  User bisa jawab dengan ANGKA PILIHAN (1/2/3, sesuai urutan list yang ditawarkan: pilihan 1="6", pilihan 2="3", pilihan 3="1") ATAU teks bebas (misal "santai"/"3 hari"/"yang cepat"). Petakan ke salah satu dari "6"/"3"/"1" sesuai maksudnya -- kalau jawabannya angka pilihan "1" artinya target "6", angka pilihan "2" artinya target "3", angka pilihan "3" artinya target "1". Kalau ambigu, null.
  ATURAN KETAT target_juz_per_hari: isi HANYA kalau pesan user JELAS merupakan jawaban pilihan (angka pilihan, atau menyebut jumlah hari / santai / sedang / cepat). Kalau pesannya berupa PERTANYAAN atau ketidakpahaman (misal "apa itu juz?", "hah?"), menyebut dua angka yang bertentangan (misal "3 eh 5 hari"), jawaban kabur (misal "yang biasa aja"), atau tidak menyebut pilihan sama sekali, WAJIB null. JANGAN menebak.
- motivasi_personal: cerita singkat apa yang bikin semangat baca Qur'an (simpan apa adanya, lowercase oke)
- mulai_surat: nama surat kalau user sebut mau mulai dari situ ATAU string "dari awal" kalau user eksplisit bilang mau mulai dari Al-Fatihah/dari awal/tidak masalah dimulai darimana. HANYA null kalau pertanyaan ini belum terjawab sama sekali di pesan ini.

Field yang TIDAK disebutkan di pesan ini -> null. Balas JSON:
{"name": null, "location": null, "gender": null, "target_juz_per_hari": null, "motivasi_personal": null, "mulai_surat": null}`;

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPromptJson },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2800, // 600 sering habis oleh reasoning (finish_reason: length) -> jawaban user hilang
      temperature: 0.2,
    });
    const result = completion.choices[0]?.message?.content?.trim();
    if (!result) {
      console.log(`⚠️  extractDataOnboarding balas kosong. finish_reason: ${completion.choices[0]?.finish_reason}`);
      return {};
    }
    const cleaned = result.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('❌ Gagal extractDataOnboarding:', err.message);
    return {};
  }
}

/**
 * Generate pesan natural: terima kasih atas info yang baru masuk (kalau ada),
 * lalu tanya field berikutnya yang masih kosong, ngobrol bukan nge-form.
 */
async function generateLanjutanOnboarding(namaUser, fieldBaruTerisi, fieldMasihKosong, pesanUserTerakhir, targetTersimpan = null) {
  if (fieldMasihKosong.length === 0) return null; // sudah lengkap, dihandle terpisah

  const labelField = {
    name: 'nama panggilan',
    location: 'domisili/kota',
    gender: 'akhi atau ukhti',
    target_juz_per_hari: 'target khatam (6 hari/3 hari/1 hari per juz)',
    motivasi_personal: 'apa yang bikin semangat baca Qur an kalau lagi males',
    mulai_surat: 'mau mulai tilawah dari surat apa (boleh skip, defaultnya dari awal)',
  };

  const fieldBerikutnya = labelField[fieldMasihKosong[0]];

  const infoTargetKhatam = fieldBaruTerisi.includes('target_juz_per_hari')
    ? '\n\nCATATAN KHUSUS: salah satu info yang baru masuk itu target_juz_per_hari. Kalau mau konfirmasi balik ke user, SEBUTKAN APA ADANYA dalam bentuk "1 juz per X hari" (misal target "6" = "1 juz tiap 6 hari, santai ya" / target "3" = "1 juz per 3 hari" / target "1" = "1 juz tiap hari, cepat nih"). ' + (targetTersimpan ? 'Target yang TERSIMPAN saat ini: "1 juz per ' + targetTersimpan + ' hari" -- sebut PERSIS ini, JANGAN memakai angka mentah dari pesan user (user bisa saja menjawab angka PILIHAN 1/2/3, bukan jumlah hari). ' : '') + 'JANGAN PERNAH menghitung ulang atau mengonversi ke bentuk lain (misal JANGAN bilang "berarti X juz sehari" atau "Y juz dalam seminggu") -- itu gampang kebalik dan salah hitung, cukup sebutkan temponya apa adanya.'
    : '';

  const prompt = `Kamu lagi kenalan santai sama ${namaUser || 'user baru'} lewat chat, ngumpulin info buat setup tilawah-nya (nama, domisili, gender akhi/ukhti, target khatam, motivasi, mulai dari surat apa).

Pesan terakhir dari user: "${pesanUserTerakhir}"
${fieldBaruTerisi.length > 0 ? `Info yang baru aja kamu dapet dari pesan itu: ${fieldBaruTerisi.join(', ')}.` : 'Belum ada info baru yang ketangkep dari pesan ini (mungkin kurang jelas).'}${infoTargetKhatam}

Yang masih perlu kamu tanyakan berikutnya: ${fieldBerikutnya}.

${fieldBaruTerisi.length === 0 ? 'PENTING: belum ada info yang tercatat dari pesan ini, jadi JANGAN mengonfirmasi/mengulang angka atau pilihan apa pun dari user seolah sudah dicatat ("oke 5 hari ya"). Kalau jawabannya kurang jelas, bilang santai bahwa kamu belum nangkep maksudnya lalu ulangi pertanyaan yang SAMA (dengan pilihan kalau ada). Kalau user balik bertanya, jawab dulu pertanyaannya singkat lalu ulangi pertanyaanmu.\n' : ''}Buatkan SATU balasan singkat, ngobrol natural kayak temen kenalan -- KALAU ada info baru, respon dulu singkat (contoh: "wah dari Bandung ya" / "oke Rina, salam kenal!"), baru lanjut nanya hal berikutnya dengan santai, JANGAN kaku kayak form/kuesioner.
KHUSUS kalau field berikutnya soal target khatam: jelaskan dulu singkat bahwa ini soal "butuh berapa hari buat nyelesain 1 juz" (biar tidak ambigu), lalu tampilkan 3 pilihannya sebagai list bernomor (1, 2, 3) biar user bisa jawab pakai angka ATAU tulisannya bebas, format persis begini di akhir pesanmu:
1. 1 juz per 6 hari (santai)
2. 1 juz per 3 hari (sedang)
3. 1 juz per 1 hari (cepat)
Balas HANYA isi pesannya, tanpa tanda kutip.`;

  return await callGroqText(prompt, 300);
}

/**
 * CTA personal setelah onboarding selesai -- menyinggung balik data yang baru
 * dikasih user (motivasi, target) biar kerasa didengar, bukan cuma "data tercatat"
 * generik, lalu kasih tau next step konkret (reminder sholat bakal mulai, dll).
 */
async function generateCTASetelahOnboarding(nama, motivasiPersonal, targetJuzPerHari, lokasi) {
  const adaMotivasi = adaIsi(motivasiPersonal);

  const instruksiArah = adaMotivasi
    ? `Dia tadi bilang motivasi personalnya: "${motivasiPersonal}". Gunakan INI sebagai titik pancingan obrolan -- perdalam santai dari situ, kepoin dikit yang related ke motivasinya itu sendiri (bukan soal ibadah/tilawah-nya, tapi soal HAL ITU sendiri sebagai bagian hidupnya). Misal kalau motivasinya nyebut suatu barang/impian/orang/kebiasaan, tanya lebih jauh soal itu dengan nada santai dan penasaran kayak temen, bukan analisis serius.`
    : `Dia tidak kasih motivasi personal spesifik, jadi tanya hal random soal dirinya sebagai orang (kesibukan, hobi, dll).`;

  const prompt = `${nama} baru aja SELESAI onboarding sama kamu (Dawam) dan baru dikasih penjelasan soal cara kerja Dawam. ${adaIsi(lokasi) ? `Domisilinya di ${lokasi}.` : ''}

${instruksiArah}

Buatkan SATU pesan PENDEK (1 kalimat saja, berupa pertanyaan), nada santai dan penasaran kayak temen ngobrol, BUKAN interogasi/formal. SAMA SEKALI JANGAN menyinggung sholat, tilawah, Qur'an, target khatam, ibadah, atau apapun yang berhubungan dengan fitur Dawam -- itu topik terpisah yang sudah selesai dibahas sebelumnya, ini murni obrolan kenalan personal.
Balas HANYA isi pesannya, tanpa tanda kutip.`;

  return await callGroqText(prompt, 300);
}

// ========== FUNGSI BARU PHASE 3: FITUR SOSIAL GRUP ==========
// Grup Dawam murni ruang sosial: lapor progress, saling semangatin, ngobrol.
// Bacaan (gambar Arab/terjemah) TIDAK PERNAH dikirim lewat fungsi-fungsi ini --
// itu tetap jalur personal yang sudah ada (kirimBacaanArab di bot.js).




/**
 * Rekap HARIAN untuk broadcast ke grup (cron jam 20:00) ATAU saat diminta manual
 * oleh anggota grup. Beda framing dari generateRekapProgressGroup: ini laporan yang
 * dawam mulai sendiri / ringkasan hari ini, bukan cuma jawab pertanyaan spontan.
 * dataRekap: array dari getRekapProgressGroup (field sudah_aktivasi_personal membedakan
 * anggota yang belum pernah kirim "dawam" ke chat pribadi vs yang sudah).
 */
/**
 * Cuma generate SATU kalimat pembuka/penutup motivasional pendek untuk ditempel
 * di rekap harian -- angka/struktur rekapnya sendiri dibangun deterministik di
 * index.js (formatRekapHarianTerstruktur), AI tidak pegang data angka di sini.
 */
async function generateKalimatMotivasiRekapHarian(adaYangDiBawahPace) {
  const prompt = `Buatkan SATU kalimat pendek (maksimal 1 kalimat) penutup untuk rekap tilawah harian grup, nadanya hangat dan menyemangati, TIDAK menyebut angka/data spesifik apapun (itu sudah ditampilkan terpisah).
${adaYangDiBawahPace ? 'Beberapa anggota masih di bawah target hari ini, kasih semangat tanpa menghakimi.' : 'Semua on track, kasih apresiasi singkat.'}
Balas HANYA kalimatnya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt, 300);
}

/**
 * Respon setup awal grup: dipakai sekali saat grup pertama kali aktivasi via keyword "dawam".
 * Perkenalan singkat bahwa Dawam di grup ini fungsinya beda dari personal (sosial, bukan kirim bacaan).
 */
async function generatePerkenalanGroupSosial() {
  const prompt = `Buatkan SATU pesan perkenalan (4-6 kalimat) untuk sebuah grup WhatsApp yang BARU SAJA mengaktifkan bot "Dawam" di dalamnya.
Jelaskan dengan nada hangat dan santai bahwa di dalam GRUP, Dawam berperan sebagai teman buat saling cerita progress tilawah, menyemangati, dan ngobrol -- BUKAN tempat menerima bacaan Al-Qur'an (karena bacaan tetap dikirim personal lewat chat pribadi masing-masing, supaya tidak spam grup).
Jelaskan juga kalau mau ngobrol/nanya ke Dawam di grup, cukup tag/mention Dawam atau reply pesannya, biar tidak mengganggu obrolan grup yang lain.
Pesan ini BOLEH diawali salam karena ini pesan pembuka baru.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt, 400);
}

// ========== HELPER: PANGGIL GROQ (existing, tidak berubah) ==========

// Jaring pengaman deterministik -- instruksi prompt saja tidak menjamin AI patuh.
// Ganti em dash/double-strip dengan koma (lebih natural buat jeda kalimat
// dibanding titik, dan tidak perlu mikir kapitalisasi ulang kata setelahnya).
function hapusDashTerlarang(teks) {
  if (!teks) return teks;
  return teks
    .replace(/\s*--\s*/g, ', ')
    .replace(/\s*—\s*/g, ', ')
    .replace(/,\s*,/g, ',') // rapikan kalau kebetulan jadi dobel koma
    .trim();
}
async function callGroqText(userPrompt, maxTokens = 350, extraOptions = {}) {
  try {
    // Naikkan max_tokens minimal secara UNCONDITIONAL -- model yang dipakai sekarang
    // kemungkinan reasoning model yang menghitung reasoning tokens ke dalam max_tokens,
    // jadi walau field reasoning_effort tidak diset, token tetap bisa habis duluan
    // sebelum nulis jawaban final kalau maxTokens kekecilan.
    const amanMinimal = Math.max(maxTokens, 2800);

    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: amanMinimal,
      temperature: 0.8,
      ...extraOptions,
    });

  const result = completion.choices[0]?.message?.content?.trim();
    if (!result) {
      console.log(`⚠️  Groq balas kosong. finish_reason: ${completion.choices[0]?.finish_reason}, max_tokens dipakai: ${amanMinimal}`);
      return null;
    }
    return hapusDashTerlarang(result);
  } catch (err) {
    console.error('❌ Groq API error:', err.message);
    return null;
  }
}

module.exports = {
  // existing
  hapusDashTerlarang,
  generateReminderSholat,
  generateTawaranNgaji,
  generateResponYa,
  generateResponTidak,
  generateFallbackChat,
  parseIntentJawaban,

  // phase 2 - generate
  generateTawaranNgajiUntukP,
  generateTawaranLanjutSesi,
  generateSudahCapaiPace,
  generatePenutupSesiBiasa,
  generateIngatkanTargetAsli,
  generateTawaranModeHalangan,
  generatePesanSetelah3xTidakBaca,

  // phase 2 - parsing
  parseSuratAyatDariJawaban,
  extractDataOnboarding,
  generateLanjutanOnboarding,
  generateCTASetelahOnboarding,

  // phase 3 - sosial grup
  generateKalimatMotivasiRekapHarian,
  generatePerkenalanGroupSosial,
};
