const db = require('./db');

const GROUP_JID = '120363412137382437@g.us';

const NOMOR_LIST = [
  '6281396903052',
  '6285719206091',
  '6281281912312',
  '6285711720049',
  '6287780013819',
  '6282123985731',
  '6282174454074',
];

for (const nomor of NOMOR_LIST) {
  const jid = `${nomor}@s.whatsapp.net`;
  db.tambahAnggotaGroup(GROUP_JID, jid);
  console.log(`✅ Ditambahkan: ${jid}`);
}

console.log('\nTotal anggota grup sekarang:', db.getAnggotaGroup(GROUP_JID));