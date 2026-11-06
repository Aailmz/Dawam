const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
});

const MODEL = process.env.AI_MODEL;
const MAX_TOOL_ITERATIONS = 5;

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
async function jalankanAgentDawam({ systemPrompt, tools, historiChat, pesanBaru, eksekutorTools, konteks }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historiChat,
    { role: 'user', content: pesanBaru },
  ];

  let iterasi = 0;

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
      return { jawabanFinal: teks, error: null };
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