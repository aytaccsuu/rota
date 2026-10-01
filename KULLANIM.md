# Rota oluşturucu

`başlat.bat` ile açın. Sayfa güncellendiğinde açık sekmeyi yenileyip evrakı tekrar yükleyin. Teslimat oturumu sayfa belleğindedir; yenilemek mevcut oturumu sıfırlar.

## Giriş ekranı

Sitede kullanıcı adı ve şifreyle giriş yapılır; oturum aynı cihazda 30 gün açık kalır, üstteki **Çıkış** ile kapatılır.

- Kullanıcılar Render → Environment → `ROTA_KULLANICILAR` değişkeninde tanımlanır: `mesut:Sifre-1, ali:Sifre-2`. Kullanıcı adında büyük/küçük harf fark etmez.
- Kullanıcı eklemek, silmek veya şifre değiştirmek için bu değişkeni düzenleyin. Silinen kullanıcının oturumu hemen geçersiz olur; şifre değişince herkesin oturumu kapanır.
- 5 hatalı denemeden sonra o cihazdan giriş 5 dakika kilitlenir.
- `ROTA_KULLANICILAR` boşsa eski `ROTA_SIFRE` (tek şifre, kullanıcı adı serbest) kullanılır. İkisi de boşsa (bilgisayarda `başlat.bat`) giriş istenmez.
- Depo/ev ve servis anahtarları bütün kullanıcılar için ortaktır.

## Plan kaydı ve veritabanı

Günlük plan (okunan duraklar, bulunan konumlar, hesaplanan sıra, teslim edilenler) her değişiklikte otomatik kaydedilir. Sayfa yenilense, çıkış yapıp tekrar girilse veya başka cihazdan girilse plan kaldığı yerden açılır. Yeni evrak yüklemek eski planın yerine geçer; “Yeni evrak için temizle” bağlantısı planı siler. Kopya ayrıca cihazın kendi hafızasında tutulur.

- Yayında kalıcılık için PostgreSQL gerekir: **Neon** ücretsiz planı (0,5 GB, süresiz; kullanılmayınca uyur ama veriyi silmez). Render → Environment → `DATABASE_URL` = Neon bağlantı adresi (`postgresql://…?sslmode=require`).
- `DATABASE_URL` yoksa plan sunucuda `planlar/` klasörüne yazılır (bilgisayarda yeterli; Render'ın ücretsiz sunucusunda uyuyup uyanınca silinir).
- Tablolar `depo.py` içindeki `SCHEMA` listesindedir; sunucu ilk bağlantıda eksik tabloları kendisi oluşturur. Yeni özellik için tablo eklemek oraya bir `CREATE TABLE IF NOT EXISTS` eklemek kadardır.
- Her kullanıcının planı ayrıdır; başkasının planı görünmez.

## Arayüz

Sol panelde depo/ev ve evrak yükleme; ana panelde ilk teslimat, mesafe/süre özeti ve mahalle başlıklarıyla teslimat sırası bulunur. Adres kontrol merkezi ayrı bir bölümdür. Düzen telefon genişliğine uyarlanır.

## Dağıtım sırası

- Depo başlangıç, ev bitiştir. Aradaki sıra, eve dönüş dahil **toplam sürüş süresi en az** olacak şekilde hesaplanır.
- Mahalle sınırı ya da "ilk durak en yakın" kuralı yoktur. Sınırdaki bir sokak komşu mahalledeki duraklara daha yakınsa onlarla birlikte gidilir. (29.09.2026 Kadıköy evrakında mahalle kuralı rotayı 98 dk'ya çıkarıyordu; elle sıra 91 dk, yeni hesap 78 dk.)
- Hesap: depodan ve evden geriye doğru en yakın komşu başlangıçları, 2-opt ve 1–3 durak taşıma iyileştirmesi, ardından sabit tohumlu "bozup yeniden iyileştir" turları. Aynı evrak her zaman aynı sırayı verir. En kısa tur garantisi verilmez.
- Aynı sipariş numarası iki kez okunursa (ör. fotoğrafta tekrar eden satır) tek sipariş sayılır.
- **Canlı trafik (TomTom):** TomTom anahtarı kayıtlıysa "🚦 Canlı trafik" seçili gelir; sıralama şu anki trafikli sürelerle yapılır, her durakta tahmini varış saati ve bacak başına trafik gecikmesi gösterilir. Ücretsiz planda günde 2500 istek var; 28 duraklık bir rota yaklaşık 750 istek harcar. Aynı noktalar için sonuç 15 dakika saklanır (adres düzeltip yeniden hesaplamak kota harcamaz). Trafik alınamazsa trafiksiz yol süreleri kullanılır ve ekranda belirtilir.
- Yol matrisi hiç alınamazsa süreler kuş uçuşundan tahmin edilir; ekranda belirtilir.
- Teyit bekleyen adres varsa rota taslak olarak gösterilir; navigasyon konumlar doğrulanınca açılır.

## Ücretsiz AVM / apartman arama

Sokak, mahalle ve bina önce mevcut Yandex veya OpenStreetMap aramasından bulunur. Bina kesin bulunamazsa AVM/site/apartman adı **Photon/OpenStreetMap** üzerinde aranır. Varsayılan arama Google'ın ücretli API'sini kullanmaz ve Google anahtarı istemez.

`Canpark`, `Canpark AVM`, site, apartman, rezidans ve yerleşke adları desteklenir. Ad, ilçe, varsa mahalle ve bina numarası yeterince eşleşirse tek sonuç doğrulanır; belirsiz sonuçlar “Düzelt / yeri teyit et” bölümünde gösterilir. AVM'nin bina ve alışveriş merkezi kayıtları aynı yerdeyse alışveriş merkezi kaydı tercih edilir; otopark veya mahalle merkezi otomatik teslimat noktası yapılmaz.

Photon kamu servisi sınırlıdır; sürekli erişim ve her binanın bulunması garanti değildir. İstekler en az bir saniye arayla planlanır, sonuçlar tarayıcıda yedi gün önbelleğe alınır. Düzenli yüksek hacimli kullanım için kendi Photon sunucusu veya uygun kapasiteli bir servis gerekir. [Photon kullanım koşulları](https://photon.komoot.io/), [OpenStreetMap atfı](https://www.openstreetmap.org/copyright).

“Google Haritalar’da aç” bağlantısı API anahtarı olmadan elle kontrol için kullanılabilir. Doğru bina noktasının koordinatını kopyalayıp “Konumu doğrula” seçin. Haritayı açmak tek başına doğrulama değildir.

Google API desteği isteğe bağlıdır. Yalnızca kendi anahtarınızı kaydedip ayrıca “Google API ile ara (ücretli, isteğe bağlı)” düğmesine basarsanız çağrılır. Otomatik evrak işleme bu API'yi çağırmaz.

## Kontroller

## Ek adres servisleri

Ayarlar → Adres servisleri ve bağlantı testleri bölümünden Yandex Geocoder, TomTom, MapTiler ve Geoapify anahtarları ayrı kaydedilir. Her satırdaki bağlantı testi gerçek bir deneme sorgusu yapar. Anahtarın kayıtlı olması çalıştığı anlamına gelmez. Anahtarlar yerel `ayarlar.json` dosyasında tutulur; ek servis anahtarları tarayıcıya geri gönderilmez. `Kaldır` ilgili kayıtlı anahtarı siler; ortam değişkeniyle verilen anahtar varsa onu kaldırmak için sunucunun ortam ayarı değiştirilmelidir.

Yandex JavaScript harita anahtarı Geocoder ürünü için geçerli olmayabilir. Ayrı Geocoder anahtarı yoksa mevcut harita anahtarı denenir. 401/403, kota, ağ/zaman aşımı ve yanıt hataları ayrı gösterilir. Geçici hata servisi kalıcı olarak kapatmaz. Yandex panelindeki ürün etkinleştirmesi ve anahtar kısıtları uygulama tarafından değiştirilemez.

Anahtarı eklenen ek servisler adres aramasına otomatik katılır; sorgular planınıza göre kota/ücret oluşturabilir. Google API sadece ayrı düğmeyle çağrılmaya devam eder. Adres aramasında TomTom Search, MapTiler Geocoding ve Geoapify Geocoding kullanılır. TomTom kendi harita verisini kullanır; MapTiler ve Geoapify OpenStreetMap tabanlıdır. İstanbul sınırları dışındaki sonuçlar elenir.

Ek servislerin yaklaşık numara sonuçları otomatik bina teyidi sayılmaz. Adres bileşenleri eşleşen adaylar arasında 50 metreden fazla fark varsa konum “Kontrol” olur ve teslimat navigasyonu teyit bekler. Bu mesafe bir doğruluk garantisi değildir; birbirine yakın farklı binalar yine elle kontrol gerektirebilir. Koordinatların ortalaması alınmaz. Aynı OpenStreetMap verisini kullanan servisler bağımsız oy sayılmaz. Ek servis yanıtları yalnızca sayfa açıkken iki dakika tutulur. “Adresleri bul” ile yeniden tarama, otomatik bulunan adresleri yeni kaynaklarla tekrar karşılaştırır; elle teyit edilenler korunur.

Ortam değişkenleri: `YANDEX_GEOCODER_API_KEY`, `TOMTOM_API_KEY`, `MAPTILER_API_KEY`, `GEOAPIFY_API_KEY`.

## Test komutları

```
node tests/logic.test.cjs
python -m unittest discover -s tests -p "test_*.py" -v
```

Testler en yakın başlangıç, aynı mahallede 10 müşteri, farklı ilçelerde aynı mahalle adı, eve dönüş maliyeti, 250 deterministik rota senaryosu, teslimata devam ve eski ağ yanıtı korumasını kapsar. Canpark'ın canlı Photon yanıtı `tests/photon-canpark.json` örneğiyle yer eşleştirmesinde sınanır. `tests/avm-ornek.csv` kişisel veri içermeyen içe aktarma örneğidir.

Görsel kontrol için `python tests/preview_ui.py` komutu kişisel veri içermeyen örneklerle 8082 portunda geçici önizleme açar. Örnek rotadaki yol maliyetleri test içindir.
