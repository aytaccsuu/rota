# İş Bul: firmalara otomatik teklif maili

Kamyonet ekibiniz için iş bulur:

1. **Firma bulur.** Google Haritalar'da (anahtar varsa) ve ücretsiz OpenStreetMap'te toptancı, üretici, e-ticaret, mobilya/beyaz eşya ve lojistik firmalarını arar. İstanbul, Kocaeli ve Tekirdağ ilçe ilçe taranır. 81 il seçilebilir.
2. **Mail adresini bulur.** Firmanın web sitesine girer; ana sayfadan ve iletişim sayfasından mail adresini çıkarır.
3. **Maili hazırlar.** Firma türüne göre, ekibinizin bilgileriyle kişiye özel teklif metni yazar.
4. **Sizin onayınızla gönderir.** *Onay bekleyen* sekmesinde bakarsınız, gerekirse düzeltirsiniz, seçip **Gönder** dersiniz.
5. **Takip eder.** Belirlediğiniz gün içinde (varsayılan 5 gün) cevap gelmeyen firmaya bir kez kısa bir hatırlatma maili hazırlar.
6. **Her sabah 09:00'da** kendiliğinden yeni firma arar, mail adreslerini bulur ve takip maillerini hazırlar.

Cevaplar doğrudan mail kutunuza gelir. Cevap gelen firmayı *Gönderilen* sekmesinde **Cevap geldi / Olumlu / Olumsuz** diye işaretlersiniz. Mail adresi bulunamayan firmalar telefonlarıyla birlikte *Telefonla* sekmesinde listelenir.

`/filo` adresi ekibinizin girişsiz açılan tanıtım sayfasıdır. Maillerde web siteniz olarak kullanılır.

## Kurulum (bir kez, yaklaşık 20 dakika)

Gerekenler: bilgisayarda [Node.js](https://nodejs.org) (LTS) ve ücretsiz bir [Cloudflare](https://dash.cloudflare.com/sign-up) hesabı.

Bu klasörde komut satırı (PowerShell) açıp sırayla çalıştırın:

```
npm install
npx wrangler login
npx wrangler d1 create isbul
```

Son komut bir `database_id` yazar. Onu `wrangler.toml` içindeki `BURAYA_DATABASE_ID` yerine yapıştırın. Sonra:

```
npm run db:remote
npx wrangler secret put ISBUL_SIFRE      (giriş şifreniz)
npx wrangler secret put ISBUL_GIZLI      (rastgele uzun bir metin, ör. klavyeye karışık 40 harf)
npm run deploy
```

`deploy` size `https://isbul.<hesabınız>.workers.dev` gibi bir adres verir. Onu telefonda ya da bilgisayarda açıp şifrenizle girin.

## Mail hesabı

Varsayılan hesap: **kocatepefilo@zohomail.eu** (sunucu `smtp.zoho.eu`, port `465`).

1. Zoho Mail → Ayarlar → **Posta Hesapları** → **IMAP Erişimi**'nin açık olduğundan emin olun.
2. Zoho'da 2 adımlı doğrulama açıksa <https://accounts.zoho.eu> → Güvenlik → **Uygulama Şifreleri**'nden "İş Bul" adıyla şifre oluşturun. Kapalıysa normal Zoho şifreniz kullanılır.
3. İş Bul → **Ayarlar**: şifreyi yazın, **Kaydet**, sonra **Kendime deneme maili gönder**.

"Giriş reddedildi" hatası çıkarsa sunucu adını Zoho Mail → Ayarlar → Posta Hesapları → **Sunucu Yapılandırma Ayrıntıları**'ndaki "giden sunucu" ile karşılaştırın.

Yeni hesapla ilk 2 hafta günde 20–30 mail gönderin; fazlası spam'e düşürebilir. Günlük sınır Ayarlar'dan değişir (varsayılan 40). İleride alan adlı bir adrese (ör. `info@kocatepefilo.com`) geçmek için Ayarlar'da adresi ve sunucuyu değiştirmeniz yeterli.

## Google anahtarı (isteğe bağlı, önerilir)

OpenStreetMap'te Türkiye'deki firma kaydı azdır. Google çok daha fazla firma bulur. [Google Cloud](https://console.cloud.google.com/google/maps-apis/credentials) → proje oluşturun → faturalandırmayı açın → **Places API (New)**'ı etkinleştirin → API anahtarı oluşturun → İş Bul → Ayarlar'a yapıştırın. Google her ay belirli sayıda aramayı ücretsiz verir. Otomatik görev günde 4 arama yapar. Elle yaptığınız aramalar da sayılır. Google Cloud'da bütçe uyarısı kurmanız iyi olur.

## Yasal not

6563 sayılı Kanun ve Ticari İletiler Yönetmeliği'ne göre esnaf ve tacirlere önceden onay almadan tanıtım maili gönderilebilir. Ancak alıcıya her mailde **ret (listeden çıkma) imkânı** verilmeli ve gönderenin kimliği yazılmalıdır. Sistem bunu kendiliğinden yapar: her mailin altına ekip bilgileriniz ve **listeden çık** bağlantısı eklenir. Bağlantıya tıklayan adrese bir daha mail gitmez. "ÇIKAR" diye cevap gelirse firmayı *Gönderilen* sekmesinde **Olumsuz** işaretleyin. Ayarlar'a ticari unvanınızı (ya da şahıs adınızı) yazın. Bireylere (gmail kullanan şahıslara) toplu mail göndermeyin.

## Test

```
npm test
```
