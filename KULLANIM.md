# Rota oluşturucu

`başlat.bat` ile açın. Sayfa güncellendiğinde açık sekmeyi yenileyip evrakı tekrar yükleyin. Teslimat oturumu sayfa belleğindedir; yenilemek mevcut oturumu sıfırlar.

## Arayüz

Sol panelde depo/ev ve evrak yükleme; ana panelde ilk teslimat, mesafe/süre özeti ve mahalle başlıklarıyla teslimat sırası bulunur. Adres kontrol merkezi ayrı bir bölümdür. Düzen telefon genişliğine uyarlanır.

## Dağıtım sırası

- Evraktaki satır sırası rotaya öncelik vermez. Aynı müşteriler farklı satır sıralarında yüklense de eşit yol maliyetleri dahil aynı plan üretilir.
- Depo başlangıç, ev bitiştir. İlk teslimat depoya karayolu mesafesi en yakın aktif duraktır.
- Aynı ilçe ve mahalledeki müşteriler tek grup halinde tamamlanır. Başka mahalleye geçip sonra aynı mahalleye teslimat için geri dönülmez. Yolun başka bir mahalleden geçmesi mümkündür.
- İlk teslimat korunarak mahallelerin sırası ve mahalle içindeki duraklar, eve dönüş dahil sürüş süresini azaltacak şekilde iyileştirilir. Her durakta eve yaklaşma şartı yoktur; en kısa tur garantisi verilmez.
- “Teslim edildi” sonrası son teslimat konumundan devam edilir. Başlanmış mahallede kalan müşteri varsa önce onlar bitirilir. “Son teslimatı geri al” yanlış işaretlemeyi geri alır.
- İlçe/mahalle bilinmiyorsa adresler gelişigüzel birleştirilmez; ayrı durak sayılır ve uyarı gösterilir. Farklı ilçelerdeki aynı adlı mahalleler ayrı gruptur.
- Yol matrisi alınamazsa yakınlık ve rota kuş uçuşundan tahmin edilir; ekranda belirtilir. Süreler canlı trafik içermez.
- Tüm adreslerin en azından yaklaşık koordinatı varsa rota taslağı gösterilir. Taslak üzerinde navigasyon/teslimata başlama kapalıdır; konumlar doğrulanınca açılır. Hiç konumu bulunmayan adres varsa hesaplama bekler, sessizce atlanmaz.
- “Adres kayıtları” evraktaki sırayı gösterir ve teslimat sırası değildir. Hesaplanan sıra üstteki “Teslimat sırası / Rota taslağı” bölümündedir. İlk durağın mesafesi ve süresi, ayrıca en yakın adaylarla karşılaştırması gösterilir.

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
