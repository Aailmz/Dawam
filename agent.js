const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  // Default SDK = timeout 10 menit x 3 percobaan; kalau provider macet, chat user menggantung lama.
  timeout: 90_000,
  maxRetries: 1,
});

const MODEL = process.env.AI_MODEL;
const MAX_TOOL_ITERATIONS = 6; // +1 cadangan untuk satu kali teguran klaim-tercatat-palsu

// Tool yang benar-benar menulis catatan bacaan ke log harian.
// Termasuk pencatat feedback power user, supaya "feedback sudah tercatat" setelah tool sukses tidak ditegur.
const NAMA_TOOL_PENCATAT = ['lapor_bacaan_manual', 'lapor_bacaan_by_ayat', 'koreksi_catatan_bacaan', 'kirim_bacaan_lanjutan', 'kirim_feedback_dawam', 'ubah_feedback_dawam'];
// Tool baca: kalau dipanggil, kata "tercatat" di jawaban kemungkinan cuma menyebut data lama.
const NAMA_TOOL_BACA = ['get_progress_user', 'tanya_bacaan_hari_lain', 'get_rekap_progress_grup', 'get_pengaturan_user', 'get_feedback_saya'];
// Klaim bentuk lampau "sudah dicatat" -- sengaja tidak menangkap "nanti aku catat" (rencana).
const POLA_KLAIM_TERCATAT = /\b(?:sudah|udah|telah|berhasil)\s+(?:(?:aku|ku|dawam)\s*)?(?:di)?catat|(?<!nanti\s|akan\s|mau\s)\baku\s+catat|\btercatat\b|\bdicatat\b|\bkucatat\b/i;
const { hapusDashTerlarang } = require('./groq');

/**
 * Orkestrasi agent Dawam (adaptasi dari jalankanAgent Harga Petani).
 * @param {string} systemPrompt
 * @param {array} tools - schema tools (personal atau grup)
 * @param {array} historiChat - [{role, content}] lama -> baru
 * @param {string} pesanBaru
 * @param {object} eksekutorTools - { nama_tool: async (args, konteks) => hasil }
 * @param {object} konteks - { jid, groupJid?, kirimBacaan?, ... } untuk eksekutor
 * @returns {{ jawabanFinal: string|null, error: string|null }}
 */
let counterGiliran = 0;

async function jalankanAgentDawam({ systemPrompt, tools, historiChat, pesanBaru, eksekutorTools, konteks }) {
  // Penanda "giliran" (satu pesan user = satu giliran). Dipakai tools.js untuk memastikan konfirmasi
  // dua langkah datang dari pesan user yang berbeda, bukan AI yang memanggil ulang sendiri.
  if (konteks) konteks.giliranId = ++counterGiliran;
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historiChat,
    { role: 'user', content: pesanBaru },
  ];

  let iterasi = 0;
  let sudahDitegurKlaimPalsu = false;
  const toolSukses = new Set();
  const toolDipanggil = new Set();
  const adaToolLapor = tools.some((t) => NAMA_TOOL_PENCATAT.includes(t.function?.name));

  while (iterasi < MAX_TOOL_ITERATIONS) {
    iterasi++;

    let completion;
    try {
      completion = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.7,
        // Model kemungkinan reasoning: reasoning token ikut kehitung di max_tokens,
        // jadi jangan kekecilan (lihat catatan di callGroqText).
        max_tokens: 1000,
      });
    } catch (err) {
      console.error('❌ Agent API error:', err.message);
      return { jawabanFinal: null, error: err.message };
    }

    const pesanAi = completion.choices[0]?.message;
    if (!pesanAi) return { jawabanFinal: null, error: 'EMPTY_RESPONSE' };
    messages.push(pesanAi);

    // Tidak minta tool -> jawaban final
    if (!pesanAi.tool_calls || pesanAi.tool_calls.length === 0) {
      const teks = pesanAi.content?.trim();
      if (!teks) {
        console.log(`⚠️  Agent balas kosong. finish_reason: ${completion.choices[0]?.finish_reason}`);
        return { jawabanFinal: null, error: 'EMPTY_CONTENT' };
      }

      // Pengaman: AI mengklaim sudah mencatat laporan bacaan padahal tool pencatat TIDAK
      // sukses dipanggil di giliran ini -> laporannya tidak masuk log/rekap harian. Tegur
      // sekali supaya AI memanggil tool (kalau user memang sudah konfirmasi) atau
      // menulis ulang jawaban tanpa klaim palsu (kalau belum).
      const adaPencatatSukses = NAMA_TOOL_PENCATAT.some((n) => toolSukses.has(n));
      const adaToolBacaDipanggil = NAMA_TOOL_BACA.some((n) => toolDipanggil.has(n));
      if (adaToolLapor && !adaPencatatSukses && !adaToolBacaDipanggil && !sudahDitegurKlaimPalsu && POLA_KLAIM_TERCATAT.test(teks)) {
        sudahDitegurKlaimPalsu = true;
        console.log('⚠️  Agent mengklaim "tercatat" tanpa tool pencatat sukses, menegur sekali:', teks.slice(0, 120));
        messages.push({
          role: 'user',
          content:
            '[PESAN SISTEM, bukan dari user] Jawabanmu barusan menyiratkan laporan bacaan atau feedback sudah dicatat, padahal TIDAK ADA tool pencatat (lapor_bacaan_by_ayat / lapor_bacaan_manual / kirim_feedback_dawam) yang berhasil dipanggil di giliran ini, jadi belum tercatat apa-apa. ' +
            'Kalau user SUDAH menyebut dengan jelas angka halaman atau surat+ayat dan sudah menyetujui rentangnya (atau, untuk power user, masukannya sudah jelas), PANGGIL tool yang sesuai SEKARANG. ' +
            'Kalau rentangnya belum dikonfirmasi atau belum jelas, tulis ulang jawabanmu: tanyakan konfirmasi/angkanya dan JANGAN bilang sudah/akan tercatat. Jangan menyebut pesan sistem ini ke user.',
        });
        continue;
      }

      return { jawabanFinal: hapusDashTerlarang(teks), error: null };
    }

    for (const toolCall of pesanAi.tool_calls) {
      const namaFungsi = toolCall.function.name;
      let argumen;
      try {
        argumen = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        argumen = {};
      }

      console.log(`🔧 Agent manggil tool: ${namaFungsi}(${JSON.stringify(argumen)})`);

      let hasilTool;
      try {
        const fungsiEksekutor = eksekutorTools[namaFungsi];
        hasilTool = fungsiEksekutor
          ? await fungsiEksekutor(argumen, konteks)
          : { error: `Tool ${namaFungsi} tidak dikenali.` };
      } catch (err) {
        console.error(`❌ Error eksekusi tool ${namaFungsi}:`, err.message);
        hasilTool = { error: `Gagal eksekusi: ${err.message}` };
      }

      toolDipanggil.add(namaFungsi);
      if (hasilTool?.sukses === true) toolSukses.add(namaFungsi);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(hasilTool),
      });
    }
  }

  console.log('⚠️  Agent mencapai batas iterasi maksimal.');
  return { jawabanFinal: null, error: 'MAX_ITERATIONS' };
}

module.exports = { jalankanAgentDawam };