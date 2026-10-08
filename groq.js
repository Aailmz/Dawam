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

// ========== GENERATE PESAN DINAMIS ==========

/**
 * Generate pesan reminder sholat yang bervariasi tiap kali dipanggil.
 */
async function generateReminderSholat(namaWaktu, namaUser) {
  const prompt = `Buatkan SATU pesan singkat (maksimal 3-4 kalimat) untuk mengingatkan ${namaUser} bahwa waktu sholat ${namaWaktu} telah tiba.
Variasikan gaya bahasanya, jangan selalu sama persis tiap kali diminta.
Boleh sesekali selipkan potongan ayat Qur'an atau hadits pendek yang relevan dengan shalat, tapi tidak wajib di setiap pesan.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip, tanpa penjelasan tambahan.`;

  return await callGroqText(prompt);
}

/**
 * Generate pesan tawaran ngaji yang bervariasi.
 */
async function generateTawaranNgaji(namaUser) {
  const prompt = `Buatkan SATU pesan singkat (maksimal 3-4 kalimat) untuk menanyakan kepada ${namaUser} apakah dia siap melanjutkan tilawah Al-Qur'an hari ini, setelah sebelumnya diingatkan shalat.
Di akhir pesan, minta dia membalas dengan kata-kata sederhana seperti "ya" atau "nanti".
Variasikan gaya bahasanya tiap kali diminta, jangan selalu template yang sama.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip, tanpa penjelasan tambahan.`;

  return await callGroqText(prompt);
}

/**
 * Generate respon setelah user bilang "ya" (mau baca), sebelum kirim gambar.
 */
async function generateResponYa(namaUser) {
  const prompt = `${namaUser} baru saja bilang "ya" (mau lanjut tilawah). Buatkan SATU kalimat pendek yang hangat dan menyemangati, sebelum bot mengirimkan gambar bacaan Al-Qur'an.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

/**
 * Generate respon setelah user bilang "nanti"/tidak mau, tetap suportif tidak menghakimi.
 */
async function generateResponTidak(namaUser) {
  const prompt = `${namaUser} baru saja bilang "nanti"/belum siap untuk tilawah hari ini. Buatkan SATU pesan singkat yang hangat, tidak menghakimi, tetap menyemangati tanpa memaksa.
Boleh sesekali selipkan hadits pendek tentang istiqomah/konsistensi dalam amal walau sedikit, tapi tidak wajib.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

/**
 * Handle chat bebas dari user yang di luar flow yang dikenali (fallback conversational).
 */
async function generateFallbackChat(namaUser, pesanUser) {
  const prompt = `${namaUser ? namaUser : 'Seseorang'} mengirim pesan berikut ke kamu (Dawam) di luar konteks flow yang biasa (bukan jawaban ya/nanti untuk ajakan tilawah):

"${pesanUser}"

Balas pesan ini secara natural dan hangat sesuai karaktermu. Jika pesannya berupa sapaan atau obrolan ringan, tanggapi dengan ramah. Jika tidak relevan sama sekali dengan konteks ibadah, tetap balas dengan sopan dan coba arahkan kembali ke topik shalat/tilawah jika pas.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callGroqText(prompt);
}

// ========== PARSING INTENT JAWABAN USER ==========

/**
 * Parse jawaban user (bebas, bukan cuma "ya"/"nanti" persis) jadi intent terstruktur.
 * Return: "YA" | "TIDAK" | "TIDAK_JELAS"
 */
async function parseIntentJawaban(pesanUser) {
  const prompt = `Seorang pengguna ditanya apakah dia siap melanjutkan tilawah Al-Qur'an. Dia menjawab:

"${pesanUser}"

Klasifikasikan jawaban ini ke SALAH SATU dari tiga kategori berikut:
- YA (kalau dia setuju/mau/siap, dalam bentuk apapun termasuk informal seperti "boleh", "gas", "siap", emoji positif, dll)
- TIDAK (kalau dia menolak/menunda, seperti "nanti", "belum", "sibuk", "engga dulu", dll)
- TIDAK_JELAS (kalau jawabannya tidak bisa ditentukan, pertanyaan lain, atau sama sekali tidak relevan)

Balas HANYA dengan satu kata: YA, TIDAK, atau TIDAK_JELAS. Tanpa penjelasan tambahan.`;

  // max_tokens dinaikkan: model reasoning (gpt-oss) kadang butuh "mikir" dulu
  // (reasoning tokens) sebelum keluarin jawaban final, jadi 10 token kemarin
  // kepotong sebelum sempat jawab. Kita juga minta reasoning_effort rendah
  // biar lebih cepat & hemat token buat task sesimpel ini.
  const hasil = await callGroqText(prompt, 100, { reasoning_effort: 'low' });

  if (!hasil) {
    console.log('⚠️  Groq gagal/kosong saat parsing intent, fallback ke keyword matching manual.');
    return fallbackKeywordIntent(pesanUser);
  }

  const cleaned = hasil.trim().toUpperCase();

  if (cleaned.includes('TIDAK_JELAS')) return 'TIDAK_JELAS';
  if (cleaned.includes('TIDAK')) return 'TIDAK';
  if (cleaned.includes('YA')) return 'YA';

  // Kalau Groq balas sesuatu yang ga mengandung kata kunci sama sekali,
  // jangan langsung nyerah ke TIDAK_JELAS -> coba fallback keyword dulu.
  console.log(`⚠️  Groq balas di luar format yang diharapkan: "${hasil}", pakai fallback keyword.`);
  return fallbackKeywordIntent(pesanUser);
}

// Fallback sederhana berbasis keyword, dipakai kalau Groq gagal/ga jelas.
// Ini jaring pengaman terakhir biar flow tetap jalan walau AI bermasalah.
function fallbackKeywordIntent(pesanUser) {
  const text = pesanUser.trim().toLowerCase();
  const jawabanYa = ['ya', 'iya', 'mau', 'yes', 'y', 'boleh', 'siap', 'gas', 'oke', 'ok'];
  const jawabanTidak = ['nanti', 'tidak', 'ga', 'gak', 'engga', 'enggak', 'no', 'belum'];

  if (jawabanYa.includes(text)) return 'YA';
  if (jawabanTidak.includes(text)) return 'TIDAK';
  return 'TIDAK_JELAS';
}

// ========== HELPER: PANGGIL GROQ ==========

async function callGroqText(userPrompt, maxTokens = 200, extraOptions = {}) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.8, // sedikit tinggi biar variatif tiap kali generate
      ...extraOptions, // misal reasoning_effort: 'low' buat task simpel kayak classification
    });

    const result = completion.choices[0]?.message?.content?.trim();
    if (!result) {
      console.log('⚠️  Groq balas kosong (kemungkinan token habis sebelum jawaban final).');
      return null;
    }
    return result;
  } catch (err) {
    console.error('❌ Groq API error:', err.message);
    return null; // caller perlu handle null (pakai fallback template biasa)
  }
}

module.exports = {
  generateReminderSholat,
  generateTawaranNgaji,
  generateResponYa,
  generateResponTidak,
  generateFallbackChat,
  parseIntentJawaban,
};