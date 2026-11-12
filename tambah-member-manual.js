const db = require('./db');

const GROUP_JID = '120363412137382437@g.us';

const NOMOR_LIST = [
  '6281252010301',
];

for (const nomor of NOMOR_LIST) {
  const jid = `${nomor}@s.whatsapp.net`;
  db.tambahAnggotaGroup(GROUP_JID, jid);
  console.log(`✅ Ditambahkan: ${jid}`);
}

console.log('\nTotal anggota grup sekarang:', db.getAnggotaGroup(GROUP_JID));