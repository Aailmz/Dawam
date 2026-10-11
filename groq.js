const Groq = require('groq-sdk');

// Ambil API key dari environment variable (JANGAN hardcode di sini)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = 'openai/gpt-oss-120b';

// ========== SYSTEM PROMPT DASAR (karakter Dawam) ==========

const SYSTEM_PROMPT = `Kamu adalah "Dawam", asisten WhatsApp islami yang ramah dan hangat.
Tugasmu mengingatkan pengguna shalat 5 waktu dan menemani mereka tilawah Al-Qur'an harian.

Gaya bicaramu:
- Hangat, lembut, tidak menggurui, tidak kaku seperti robot
- Islami tapi natural, sesekali sisipkan ayat/hadits pendek yang relevan (opsional, jangan dipaksakan tiap pesan)
- Selalu panggil nama pengguna kalau nama diberikan
- Singkat, padat, tidak bertele-tele (ini WhatsApp, bukan artikel)
- Tidak menghakimi kalau pengguna menolak/menunda
- Gunakan emoji secukupnya, jangan berlebihan`;

// ========== GENERATE PESAN DINAMIS (existing, tidak berubah) ==========

async function generateReminderSholat(namaWaktu, namaUser) {
  const prompt = `Buatkan SATU pesan singkat (maksimal 3-4 kalimat) untuk mengingatkan ${namaUser} bahwa waktu sholat ${namaWaktu} telah tiba.
Variasikan gaya bahasanya, jangan selalu sama persis tiap kali diminta.
Boleh sesekali selipkan potongan ayat Qur'an atau hadits pendek yang relevan dengan shalat, tapi tidak wajib di setiap pesan.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip, tanpa penjelasan tambahan.`;

  return await callGroqText(prompt);
}

async function generateTawaranNgaji(namaUser) {
  const prompt = `Buatkan SATU pesan singkat (maksimal 3-4 kalimat) untuk menanyakan kepada ${namaUser} apakah dia siap melanjutkan tilawah Al-Qur'an hari ini, setelah sebelumnya diingatkan shalat.
Di akhir pesan, minta dia membalas dengan kata-kata sederhana seperti "ya" atau "nanti".
Variasikan gaya bahasanya tiap kali diminta, jangan selalu template yang sama.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip, tanpa penjelasan tambahan.`;

  return await callGroqText(prompt);
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
  const prompt = `${namaUser} baru saja bilang "ya" (mau lanjut tilawah). Buatkan SATU kalimat pendek yang hangat dan menyemangati, sebelum bot mengirimkan gambar bacaan Al-Qur'an.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

async function generateResponTidak(namaUser) {
  const prompt = `${namaUser} baru saja bilang "nanti"/belum siap untuk tilawah hari ini. Buatkan SATU pesan singkat yang hangat, tidak menghakimi, tetap menyemangati tanpa memaksa.
Boleh sesekali selipkan hadits pendek tentang istiqomah/konsistensi dalam amal walau sedikit, tapi tidak wajib.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

async function generateFallbackChat(namaUser, pesanUser) {
  const prompt = `${namaUser ? namaUser : 'Seseorang'} mengirim pesan berikut ke kamu (Dawam) di luar konteks flow yang biasa (bukan jawaban ya/nanti untuk ajakan tilawah):

"${pesanUser}"

Balas pesan ini secara natural dan hangat sesuai karaktermu. Jika pesannya berupa sapaan atau obrolan ringan, tanggapi dengan ramah. Jika tidak relevan sama sekali dengan konteks ibadah, tetap balas dengan sopan dan coba arahkan kembali ke topik shalat/tilawah jika pas.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

// ========== FUNGSI BARU PHASE 2: GENERATE PESAN ==========

/**
 * Tawaran baca terjemah setelah baca Arab (§5).
 */
async function generateTawaranTerjemah(namaUser) {
  const prompt = `${namaUser} baru saja selesai membaca kartu bacaan Arab. Buatkan SATU pesan singkat (2-3 kalimat) menanyakan apakah dia mau lanjut membaca artinya (terjemah) juga.
Minta dia membalas dengan kata-kata sederhana seperti "ya" atau "nanti"/"tidak".
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

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
  const motivasiText = motivasiPersonal
    ? `'${motivasiPersonal}'`
    : `tidak ada catatan motivasi spesifik, jadi gunakan motivasi umum yang hangat`;

  const prompt = `${namaUser} sudah 3 kali berturut-turut belum sempat tilawah. Buatkan SATU pesan (3-4 kalimat) yang:
1. Menanyakan dengan lembut apa yang membuatnya belum sempat, TANPA menghakimi sama sekali.
2. Mengingatkan dia dengan motivasi personalnya sendiri, yaitu: ${motivasiText} -- gunakan ini sebagai pengingat hangat, BUKAN tekanan atau kalimat menyalahkan.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

/**
 * Konfirmasi hangat saat mode terjemah-saja diaktifkan/dinonaktifkan (§6.2, §6.3).
 */
async function generateKonfirmasiModeHalangan(namaUser, aktifkan) {
  const instruksi = aktifkan
    ? `memberitahu bahwa mode terjemah-saja sudah diaktifkan untuknya -- mulai sekarang dia akan menerima bacaan terjemah saja (tanpa Arab) sampai dia bilang sudah selesai`
    : `memberitahu bahwa mode terjemah-saja sudah dinonaktifkan -- mulai sekarang dia akan kembali menerima bacaan Arab seperti biasa`;

  const prompt = `Buatkan SATU pesan pendek (1-2 kalimat) untuk ${namaUser}, ${instruksi}.
Nada hangat dan suportif, tidak kaku.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

// ========== PARSING INTENT JAWABAN (existing, tidak berubah) ==========

async function parseIntentJawaban(pesanUser) {
  const prompt = `Seorang pengguna ditanya apakah dia siap melanjutkan tilawah Al-Qur'an. Dia menjawab:

"${pesanUser}"

Klasifikasikan jawaban ini ke SALAH SATU dari tiga kategori berikut:
- YA (kalau dia setuju/mau/siap, dalam bentuk apapun termasuk informal seperti "boleh", "gas", "siap", emoji positif, dll)
- TIDAK (kalau dia menolak/menunda, seperti "nanti", "belum", "sibuk", "engga dulu", dll)
- TIDAK_JELAS (kalau jawabannya tidak bisa ditentukan, pertanyaan lain, atau sama sekali tidak relevan)

Balas HANYA dengan satu kata: YA, TIDAK, atau TIDAK_JELAS. Tanpa penjelasan tambahan.`;

  const hasil = await callGroqText(prompt, 100, { reasoning_effort: 'low' });

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
  const text = pesanUser.trim().toLowerCase();
  const jawabanYa = ['ya', 'iya', 'mau', 'yes', 'y', 'boleh', 'siap', 'gas', 'oke', 'ok'];
  const jawabanTidak = ['nanti', 'tidak', 'ga', 'gak', 'engga', 'enggak', 'no', 'belum'];

  if (jawabanYa.includes(text)) return 'YA';
  if (jawabanTidak.includes(text)) return 'TIDAK';
  return 'TIDAK_JELAS';
}

// ========== FUNGSI BARU PHASE 2: PARSING ==========

/**
 * Parse jawaban onboarding gender jadi 'L' | 'P' | 'TIDAK_JELAS' (§3 poin 3).
 */
async function parseGenderDariJawaban(pesanUser) {
  const prompt = `Seorang pengguna ditanya apakah dia "Akhi" (laki-laki) atau "Ukhti" (perempuan). Dia menjawab:

"${pesanUser}"

Klasifikasikan ke SALAH SATU:
- L (kalau menjawab laki-laki/akhi/cowok/pria/ikhwan, dalam bentuk apapun)
- P (kalau menjawab perempuan/ukhti/cewek/wanita/akhwat, dalam bentuk apapun)
- TIDAK_JELAS (kalau tidak bisa ditentukan)

Balas HANYA dengan satu kata: L, P, atau TIDAK_JELAS.`;

  const hasil = await callGroqText(prompt, 50, { reasoning_effort: 'low' });
  if (!hasil) return 'TIDAK_JELAS';

  const cleaned = hasil.trim().toUpperCase();
  if (cleaned.includes('TIDAK_JELAS')) return 'TIDAK_JELAS';
  if (cleaned.startsWith('L')) return 'L';
  if (cleaned.startsWith('P')) return 'P';
  return 'TIDAK_JELAS';
}

/**
 * Parse jawaban onboarding target kecepatan jadi '6' | '3' | '1' | 'TIDAK_JELAS' (§3 poin 4).
 */
async function parseTargetDariJawaban(pesanUser) {
  const prompt = `Seorang pengguna ditanya mau targetkan khatam 1 juz Al-Qur'an berapa hari, dengan 3 pilihan: 6 hari (santai), 3 hari (sedang), atau 1 hari (cepat). Dia menjawab:

"${pesanUser}"

Klasifikasikan jawabannya ke SALAH SATU: 6, 3, 1, atau TIDAK_JELAS (kalau tidak bisa ditentukan angkanya).
Balas HANYA dengan satu kata/angka itu saja.`;

  const hasil = await callGroqText(prompt, 50, { reasoning_effort: 'low' });
  if (!hasil) return 'TIDAK_JELAS';

  const cleaned = hasil.trim();
  if (cleaned.includes('6')) return '6';
  if (cleaned.includes('3')) return '3';
  if (cleaned.includes('1')) return '1';
  return 'TIDAK_JELAS';
}

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
      max_tokens: 150,
      temperature: 0.2,
      reasoning_effort: 'low',
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
 * Parse pesan bebas untuk deteksi niat aktifkan/nonaktifkan mode terjemah-saja (§6.3).
 * Return: 'AKTIFKAN' | 'NONAKTIFKAN' | 'TIDAK_RELEVAN'
 */
async function parseModeHalanganIntent(pesanUser) {
  const prompt = `Seorang pengguna (perempuan) sedang mengobrol dengan bot pengingat tilawah Al-Qur'an. Bot punya fitur "mode terjemah-saja" untuk saat pengguna sedang halangan (haid) dan tidak ingin/tidak bisa memegang mushaf Arab -- dalam mode ini bot hanya kirim bacaan terjemah, bukan Arab.

Pesan dari pengguna:
"${pesanUser}"

Klasifikasikan niat pesan ini ke SALAH SATU:
- AKTIFKAN (kalau dia memberi tahu sedang halangan/haid/tidak mau pegang mushaf dulu/minta terjemah saja dulu, dalam bentuk apapun)
- NONAKTIFKAN (kalau dia memberi tahu sudah selesai halangan/sudah suci/mau baca Arab lagi/mau kembali ke mode normal)
- TIDAK_RELEVAN (kalau pesan ini sama sekali tidak berkaitan dengan topik halangan/mode baca, misalnya obrolan biasa, pertanyaan lain, jawaban ya/nanti untuk ajakan tilawah, dll)

Balas HANYA dengan satu kata: AKTIFKAN, NONAKTIFKAN, atau TIDAK_RELEVAN.`;

  const hasil = await callGroqText(prompt, 50, { reasoning_effort: 'low' });
  if (!hasil) return 'TIDAK_RELEVAN';

  const cleaned = hasil.trim().toUpperCase();
  if (cleaned.includes('TIDAK_RELEVAN')) return 'TIDAK_RELEVAN';
  if (cleaned.includes('NONAKTIFKAN')) return 'NONAKTIFKAN';
  if (cleaned.includes('AKTIFKAN')) return 'AKTIFKAN';
  return 'TIDAK_RELEVAN';
}

// ========== HELPER: PANGGIL GROQ (existing, tidak berubah) ==========

async function callGroqText(userPrompt, maxTokens = 200, extraOptions = {}) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.8,
      ...extraOptions,
    });

    const result = completion.choices[0]?.message?.content?.trim();
    if (!result) {
      console.log('⚠️  Groq balas kosong (kemungkinan token habis sebelum jawaban final).');
      return null;
    }
    return result;
  } catch (err) {
    console.error('❌ Groq API error:', err.message);
    return null;
  }
}

module.exports = {
  // existing
  generateReminderSholat,
  generateTawaranNgaji,
  generateResponYa,
  generateResponTidak,
  generateFallbackChat,
  parseIntentJawaban,

  // phase 2 - generate
  generateTawaranNgajiUntukP,
  generateTawaranTerjemah,
  generateTawaranLanjutSesi,
  generateIngatkanTargetAsli,
  generateTawaranModeHalangan,
  generatePesanSetelah3xTidakBaca,
  generateKonfirmasiModeHalangan,

  // phase 2 - parsing
  parseGenderDariJawaban,
  parseTargetDariJawaban,
  parseSuratAyatDariJawaban,
  parseModeHalanganIntent,
};