const db = require('./db');

const GROUP_JID = '120363412137382437@g.us';
const USER_JID = '628119194409@s.whatsapp.net';

db.tambahAnggotaGroup(GROUP_JID, USER_JID);
console.log('✅ Ditambahkan. Anggota grup sekarang:', db.getAnggotaGroup(GROUP_JID));