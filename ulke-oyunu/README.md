# Ülke Oyunu

Yerelde: `node server.js` → http://localhost:3000 (index.html'e çift tıklayınca çalışmaz, sunucu şart)

## Render'a kurulum
1. Bu klasörü bir GitHub deposuna yükle (4 dosya: server.js, index.html, package.json, render.yaml).
2. render.com → New + → Web Service → depoyu seç.
   Build Command: boş bırak veya `echo ok` · Start Command: `node server.js`
3. Açılan https://....onrender.com adresini arkadaşlarına gönder. Herkes aynı adresi açınca aynı dünya listesini görür.

Notlar:
- Ücretsiz planda disk kalıcı değil: sunucu yeniden başlarsa/yeniden deploy edilirse dünyalar sıfırlanır.
  Kalıcılık için ücretli planda Disk ekle ve DATA_DIR ortam değişkenini disk yoluna ayarla (örn. /var/data).
- Ücretsiz plan ~15 dk kimse girmezse uyur; ilk giriş 30-60 sn sürebilir.
- Dünya içinde sadece oyuncu varken simülasyon çalışır.
