# Dawam
Work in Progress.

## Power User (feedback ke tim)

User tertentu bisa memberi masukan ke Dawam lewat chat biasa. Masukan disimpan ke DB, dirapikan, dan
dikirim sebagai satu digest ke nomor operator tiap malam. Pengerjaannya dilakukan manusia.

Konfigurasi `.env`:

| Variabel | Fungsi |
| --- | --- |
| `OPERATOR_NUMBER` | Nomor operator (contoh `081234567890`). Wajib untuk digest dan perintah operator. Operator otomatis power user. |
| `FEEDBACK_DIGEST_CRON` | Opsional, bentuk `M H * * *`. Default `0 21 * * *` (21:00 WIB). |

Perintah dari nomor operator (chat pribadi ke Dawam):

```
/power tambah 0812xxxx        jadikan power user
/power hapus 0812xxxx
/power daftar
/feedback daftar              feedback yang belum selesai
/feedback kirim               kirim digest sekarang
/feedback selesai 12-15 [catatan]   tandai selesai, pengirimnya otomatis dikabari
```

Kalau bot mati saat jam kirim, digest hari itu dikirim begitu bot hidup lagi (selama masih ada feedback
yang menunggu). Tabel baru: `power_users`, `feedback_power`, `feedback_digest_log` (dibuat otomatis,
tabel lama tidak diubah).
