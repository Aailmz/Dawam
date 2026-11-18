const OpenAI = require('openai');

// Timeout & retry dibatasi: tanpa ini request yang macet bisa menggantung sampai 10 menit dan
// user tidak dapat respons apa pun. 90 detik cukup longgar untuk model reasoning yang lambat.
const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: 90_000,
  maxRetries: 1,
});

const MODEL = process.env.AI_MODEL;
// Model reasoning menghitung reasoning token ke dalam max_tokens; 1000 bisa habis sebelum jawaban
// final ditulis. Ini hanya batas atas (tidak menambah biaya kalau tidak terpakai).
const MAX_TOKENS_AGENT = 2800;
const MAX_TOOL_ITERATIONS = 6; // +1 cadangan untuk satu kali teguran klaim-tercatat-palsu

// Tool yang benar-benar menulis catatan bacaan ke log harian.
const NAMA_TOOL_PENCATAT = ['lapor_bacaan_manual', 'lapor_bacaan_by_ayat', 'koreksi_catatan_bacaan', 'kirim_bacaan_lanjutan', 'catat_masukan_user', 'catat_user_belum_baca'];
// Tool baca: kalau dipanggil, kata "tercatat" di jawaban kemungkinan cuma menyebut data lama.
const NAMA_TOOL_BACA = ['get_progress_user', 'tanya_bacaan_hari_lain', 'get_rekap_progress_grup', 'get_pengaturan_user'];
// Klaim bentuk lampau "sudah dicatat" -- sengaja tidak menangkap "nanti aku catat" (rencana).
const POLA_KLAIM_TERCATAT = /\b(?:sudah|udah|telah|berhasil)\s+(?:(?:aku|ku|dawam)\s*)?(?:di)?catat|(?<!nanti\s|akan\s|mau\s)\baku\s+catat|\btercatat\b|\bdicatat\b|\bkucatat\b/i;
// Kalimat klarifikasi/penolakan ("belum aku catat", "biar aku catat", "mau dicatat?") BUKAN klaim
// palsu -- tanpa pengecualian ini teguran sistem salah sasaran dan memaksa model memanggil tool
// (bahkan tool acak) sebelum user mengonfirmasi.
const POLA_BUKAN_KLAIM = /\?|\b(?:belum|biar|supaya|agar|mau|akan|nanti)\b/i;
// Tool dengan efek keluar (kirim gambar / tulis ke grup): tidak boleh dijalankan dua kali dengan
// argumen sama dalam satu giliran (model kadang memanggil dobel).
const NAMA_TOOL_EFEK_KELUAR = [...NAMA_TOOL_PENCATAT, 'kirim_terjemah_bacaan', 'broadcast_ke_grup_sosial', 'minta_rekap_harian', 'tag_anggota_grup', 'klaim_card_kawan'];
const { hapusDashTerlarang } = require('./groq');

/**
 * Orkestrasi agent Dawam (adaptasi dari jalankanAgent Harga Petani).
 * @param {string} systemPrompt
 * @param {array} tools - schema tools (personal atau grup)
 * @param {array} historiChat - [{role, content}] lama -> baru
 * @param {string} pesanBaru
 * @param {object} eksekutorTools - { nama_tool: async (args, konteks) => hasil }
 * @param {object} konteks - { jid, groupJid?, kirimBacaan?, ... } untuk eksekutor
 * @returns {{ jawabanFinal: string|null, error: string|null, toolSukses: string[] }}
 *   toolSukses: nama tool yang berhasil -- dipakai pemanggil untuk memilih pesan yang pantas kalau
 *   AI gagal SETELAH tool (misal kartu) sudah terkirim.
 */
async function jalankanAgentDawam({ systemPrompt, tools, historiChat, pesanBaru, eksekutorTools, konteks }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historiChat,
    { role: 'user', content: pesanBaru },
  ];

  let iterasi = 0;
  let sudahDitegurKlaimPalsu = false;
  const toolSukses = new Set();
  const toolDipanggil = new Set();
  const sudahDijalankan = new Set(); // 'nama|argumen' untuk tool berefek keluar
  const hasilAkhir = (jawabanFinal, error) => ({ jawabanFinal, error, toolSukses: [...toolSukses] });
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
        max_tokens: MAX_TOKENS_AGENT,
      });
    } catch (err) {
      console.error('❌ Agent API error:', err.message);
      return hasilAkhir(null, err.message);
    }

    const pesanAi = completion.choices[0]?.message;
    if (!pesanAi) return hasilAkhir(null, 'EMPTY_RESPONSE');
    messages.push(pesanAi);

    // Tidak minta tool -> jawaban final
    if (!pesanAi.tool_calls || pesanAi.tool_calls.length === 0) {
      const teks = pesanAi.content?.trim();
      if (!teks) {
        console.log(`⚠️  Agent balas kosong. finish_reason: ${completion.choices[0]?.finish_reason}`);
        return hasilAkhir(null, 'EMPTY_CONTENT');
      }

      // Pengaman: AI mengklaim sudah mencatat laporan bacaan padahal tool pencatat TIDAK
      // sukses dipanggil di giliran ini -> laporannya tidak masuk log/rekap harian. Tegur
      // sekali supaya AI memanggil tool (kalau user memang sudah konfirmasi) atau
      // menulis ulang jawaban tanpa klaim palsu (kalau belum).
      const adaPencatatSukses = NAMA_TOOL_PENCATAT.some((n) => toolSukses.has(n));
      const adaToolBacaDipanggil = NAMA_TOOL_BACA.some((n) => toolDipanggil.has(n));
      if (adaToolLapor && !adaPencatatSukses && !adaToolBacaDipanggil && !sudahDitegurKlaimPalsu && POLA_KLAIM_TERCATAT.test(teks) && !POLA_BUKAN_KLAIM.test(teks)) {
        sudahDitegurKlaimPalsu = true;
        console.log('⚠️  Agent mengklaim "tercatat" tanpa tool pencatat sukses, menegur sekali:', teks.slice(0, 120));
        messages.push({
          role: 'user',
          content:
            '[PESAN SISTEM, bukan dari user] Jawabanmu barusan menyiratkan laporan bacaan sudah dicatat, padahal TIDAK ADA tool pencatat (lapor_bacaan_by_ayat / lapor_bacaan_manual) yang berhasil dipanggil di giliran ini, jadi belum tercatat apa-apa. ' +
            'Kalau user SUDAH menyebut dengan jelas angka halaman atau surat+ayat dan sudah menyetujui rentangnya, PANGGIL tool yang sesuai SEKARANG. ' +
            'Kalau rentangnya belum dikonfirmasi atau belum jelas, tulis ulang jawabanmu: tanyakan konfirmasi/angkanya dan JANGAN bilang sudah/akan tercatat. Jangan menyebut pesan sistem ini ke user.',
        });
        continue;
      }

      return hasilAkhir(hapusDashTerlarang(teks), null);
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
      const kunciPanggilan = `${namaFungsi}|${JSON.stringify(argumen)}`;
      try {
        const fungsiEksekutor = eksekutorTools[namaFungsi];
        if (NAMA_TOOL_EFEK_KELUAR.includes(namaFungsi) && sudahDijalankan.has(kunciPanggilan)) {
          hasilTool = {
            sukses: false,
            pesan: 'Tool ini sudah dijalankan dengan argumen yang sama di giliran ini. JANGAN diulang, cukup lanjutkan jawabanmu berdasarkan hasil sebelumnya.',
          };
        } else if (fungsiEksekutor) {
          sudahDijalankan.add(kunciPanggilan);
          hasilTool = await fungsiEksekutor(argumen, konteks);
        } else {
          hasilTool = { error: `Tool ${namaFungsi} tidak dikenali.` };
        }
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
  return hasilAkhir(null, 'MAX_ITERATIONS');
}

module.exports = { jalankanAgentDawam };