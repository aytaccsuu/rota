"""Evrak fotoğrafını Google Gemini ile okuyup teslimat satırlarına çevirir.

Anahtar yalnızca sunucuda durur (GEMINI_API_KEY ya da ayarlar.json "geminiKey").
Not: Gemini ücretsiz planında Google gönderilen içeriği ürün geliştirmede kullanabilir.
"""
import json
import os
import urllib.request

from providers import SSL_CONTEXT

# Ücretsiz planda her modelin ayrı (ve düşük: ör. günde 20) kotası var; biri dolunca/yoğunsa sıradakine geçilir.
# Gemini 2.5 modelleri kullanılmaz: istenen JSON şemasını yok sayıp düz metin döndürüyorlar.
MODELS = [m.strip() for m in os.environ.get(
    "GEMINI_MODELS", "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite").split(",") if m.strip()]
# Fotoğraf okuma yalnız Gemini 3 modelleriyle: 2.5 modelleri görseli düşük çözünürlükte (~258 token) işliyor,
# geniş tabloda sipariş numaralarını bozuyor. Gemini 3'te görsel "ultra_high" (2240 token) gönderilir.
OCR_MODELS = [m for m in MODELS if not m.startswith("gemini-2.")]
URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

PROMPT = """Bu fotoğraf bir kargo dağıtım evrakı (tablo). Fotoğraf yan dönmüş, eğik veya katlanmış olabilir.
Tablodaki HER teslimat satırını oku ve şemaya göre döndür.

Kurallar:
- Metni kağıtta yazdığı gibi aktar; tahmin etme, uydurma, düzeltme yapma. Okunamayan kısmı boş bırak.
- Bir hücre birden fazla satıra yayılmışsa (ör. uzun adres veya "Esra Kutsal / (2 parça teslim olsun)") satırları doğru sırayla tek metinde birleştir.
- Alıcı hücresinde parantez içindeki notları (ör. "2 parça teslim olsun") "not" alanına koy; "alici" sadece kişi/mağaza adı olsun.
- Mağaza kodu (ör. "TUR.Ist.GS.mll.METROGARDEN.I") alıcı adıdır, aynen yaz.
- "adres" sütununun tamamını al: mahalle, sokak/cadde, apartman, no, kat, daire dahil.
- Kalemle sonradan yazılmış sıra numaralarını, imzaları ve başlık satırını alma.
- "GERİ ALIM" yazan satırlarda geri_alim true olsun.
- Aynı satırı iki kez yazma.
- Yanıtı yalnızca JSON olarak ver, açıklama yazma."""

SCHEMA = {
    "type": "object",
    "properties": {
        "rows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "musteri": {"type": "string", "description": "Müşteri/firma sütunu (IKEA, Bauhaus, İpekyol...)"},
                    "siparis_no": {"type": "string"},
                    "alici": {"type": "string"},
                    "not": {"type": "string"},
                    "adet": {"type": "string"},
                    "ilce": {"type": "string"},
                    "adres": {"type": "string"},
                    "geri_alim": {"type": "boolean"},
                },
                "required": ["musteri", "siparis_no", "alici", "not", "adet", "ilce", "adres", "geri_alim"],
            },
        }
    },
    "required": ["rows"],
}


class OkumaHatasi(Exception):
    def __init__(self, message, code="upstream"):
        super().__init__(message)
        self.code = code


def _post(url, body, key):
    """Gemini'ye istek; ücretsiz planda sık görülen geçici 500/503 hatalarında 3 kez tekrar dener."""
    import time
    import urllib.error
    for attempt in range(2):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=90, context=SSL_CONTEXT) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in (500, 502, 503, 504) or attempt == 1:
                raise
            time.sleep(2)


def _generate(parts, schema, key, models=None, groq_key=None):
    """Önce Gemini; Gemini anahtarı yoksa ya da kotası/bağlantısı biterse Groq yedeği (varsa)."""
    if not key:
        if groq_key:
            return _groq(parts, schema, groq_key)
        raise OkumaHatasi("Yapay zekâ anahtarı tanımlı değil.", "auth")
    try:
        return _gemini(parts, schema, key, models)
    except OkumaHatasi:
        if not groq_key:
            raise
        return _groq(parts, schema, groq_key)


GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = os.environ.get("GROQ_MODEL", "qwen/qwen3.8-27b")


def _groq(parts, schema, key):
    """Groq (OpenAI uyumlu) yedek modeli: metin + isteğe bağlı görsel, JSON yanıt."""
    import re
    import urllib.error
    content = []
    for p in parts:
        if p.get("type") == "image":
            content.append({"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (p.get("mime_type") or "image/jpeg", p["data"])}})
        else:
            content.append({"type": "text", "text": p.get("text", "")})
    content.append({"type": "text", "text": "Yanıtı yalnızca şu JSON şemasına uyan tek bir JSON nesnesi olarak ver:\n" + json.dumps(schema, ensure_ascii=False)})
    body = {"model": GROQ_MODEL, "messages": [{"role": "user", "content": content}], "temperature": 0,
            "max_completion_tokens": 8000, "response_format": {"type": "json_object"}}
    req = urllib.request.Request(GROQ_URL, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key, "User-Agent": "rota-plani/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=90, context=SSL_CONTEXT) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise OkumaHatasi("Groq anahtarı reddedildi. Anahtarı kontrol edin.", "auth")
        if error.code == 429:
            raise OkumaHatasi("Gemini ve Groq ücretsiz kullanım sınırları doldu. Biraz sonra tekrar deneyin.", "quota")
        raise OkumaHatasi("Groq şu an yanıt vermiyor (%s)." % error.code)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise OkumaHatasi("Groq şu an yanıt vermiyor (%s)." % type(error).__name__)
    try:
        text = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise OkumaHatasi("Groq yanıtı anlaşılamadı.", "response")
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def _gemini(parts, schema, key, models=None):
    """Model zincirini sırayla dener; anahtar hatası hariç her hatada sıradaki modele geçer."""
    import urllib.error
    last = None
    for model in (models or MODELS):
        body = {"model": model, "input": parts, "response_format": {"type": "text", "mime_type": "application/json", "schema": schema},
                "generation_config": {"thinking_level": "low"}}
        try:
            try:
                data = _post(URL, body, key)
            except urllib.error.HTTPError as error:
                if error.code != 400:
                    raise
                body.pop("generation_config")  # bazı modeller düşünme ayarını kabul etmiyor
                data = _post(URL, body, key)
            return "".join(_texts(data.get("steps") or data.get("outputs") or data))
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise OkumaHatasi("Gemini anahtarı reddedildi. Anahtarı kontrol edin.", "auth")
            last = error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last = error  # zaman aşımı / bağlantı: sıradaki model
    if isinstance(last, urllib.error.HTTPError) and last.code == 429:
        raise OkumaHatasi("Gemini ücretsiz kullanım sınırı bütün modellerde doldu. Yarın tekrar deneyin veya yerel okuyucu kullanılır.", "quota")
    raise OkumaHatasi("Gemini şu an yanıt vermiyor (%s). Biraz sonra tekrar deneyin." % (getattr(last, "code", None) or type(last).__name__))


def _texts(node):
    """Yanıttaki tüm "text" alanlarını sırayla toplar (yanıt biçimi sürüme göre değişebiliyor)."""
    if isinstance(node, dict):
        if isinstance(node.get("text"), str) and node.get("type", "text") == "text" and not node.get("thought"):
            yield node["text"]
        for k, v in node.items():
            if k != "text":
                yield from _texts(v)
    elif isinstance(node, list):
        for v in node:
            yield from _texts(v)


def _loose_json(text, list_key):
    """Şemayı dikkate almayan modeller için: ```json çitlerini at, dizi ya da {list_key: [...]} kabul et."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t[3:]
        t = t.rsplit("```", 1)[0]
    data = json.loads(t)
    if isinstance(data, dict):
        data = data.get(list_key) or next((v for v in data.values() if isinstance(v, list)), None)
    if not isinstance(data, list):
        raise ValueError("liste yok")
    return data


ALIASES = {"siparis_no": ("siparis_no", "siparis_numarasi", "siparisNo", "siparis"), "geri_alim": ("geri_alim", "geriAlim")}


def _field(r, key):
    for k in ALIASES.get(key, (key,)):
        if r.get(k) not in (None, ""):
            return r[k]
    return ""


def read_document(image_b64, mime, key, groq_key=None):
    """Fotoğraftaki tabloyu [{musteri, siparis_no, alici, not, adet, ilce, adres, geri_alim}] listesine çevirir."""
    text = _generate([{"type": "text", "text": PROMPT}, {"type": "image", "data": image_b64, "mime_type": mime, "resolution": "ultra_high"}], SCHEMA, key, OCR_MODELS, groq_key)
    try:
        rows = _loose_json(text, "rows")
    except (ValueError, KeyError, TypeError, IndexError):
        raise OkumaHatasi("Yapay zekâ yanıtı anlaşılamadı.", "response")
    clean = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        row = {k: str(_field(r, k) or "").strip() for k in ("musteri", "siparis_no", "alici", "not", "adet", "ilce", "adres")}
        row["geri_alim"] = _field(r, "geri_alim") in (True, "true", "True", "evet")
        if len(row["adres"]) >= 6:
            clean.append(row)
    return clean


DUZELT_PROMPT = """Aşağıda İstanbul'daki teslimat adresleri var (fotoğraftan okunmuş, yazım hataları olabilir).
Her adres için şemaya göre alanları doldur.

Kurallar:
- Yalnızca BARİZ okuma/yazım hatalarını düzelt: "Solak"→"Sokak", "lat 9"→"kat 9", "Dalre"→"Daire",
  bilinen sokak/mahalle adındaki tek harf hataları (ör. "Tünelc Sok."→"Tünek Sokak"). Emin değilsen olduğu gibi bırak.
- Adreste olmayan sokak, numara veya mahalle UYDURMA. Yoksa boş bırak.
- sokak: kapı numarasının ait olduğu yol, tam adıyla ("Tepegöz Sokak", "Bağdat Caddesi"). Adreste birden çok yol varsa
  (ör. "Çetin Emeç Bulvarı Su yanı Sokak ... No:7") numaradan hemen önce yazılan yolu seç ("Su Yanı Sokak").
- sokak_adaylari: sokak adı okunurken bozulmuş olabilirse (ör. "Tünelc Sok.") en olası doğru yazımlar, en fazla 3
  ("Tünek Sokak"). Adreste başka bir yol daha yazıyorsa onu da ekle. Emin olduğun adlarda boş liste.
- mahalle: sadece adı ("Göztepe"), "Mahallesi" yazma. Adreste birden çok mahalle geçiyorsa sokağın bağlı olduğunu seç.
- kapi_no: bina kapı numarası, yazıldığı gibi ("49/21", "4-6", "12A"). "No:334", "No 334", "no334", "N:334", "Nu 334",
  "numara 334" ya da "No" yazılmadan sokaktan hemen sonra gelen "334" hepsi kapı numarasıdır → "334". Daire/kat numarası kapı no değildir.
- daire, kat: varsa.
- bina: apartman/site/plaza/AVM adı varsa ("Utku Apt.", "Kozzy AVM").
- duzeltmeler: yaptığın her düzeltmeyi "eski → yeni" biçiminde yaz; düzeltme yoksa boş liste.
- Yanıtı yalnızca JSON olarak ver, açıklama yazma.
"""

DUZELT_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "mahalle": {"type": "string"},
                    "sokak": {"type": "string"},
                    "sokak_adaylari": {"type": "array", "items": {"type": "string"}},
                    "kapi_no": {"type": "string"},
                    "daire": {"type": "string"},
                    "kat": {"type": "string"},
                    "bina": {"type": "string"},
                    "ilce": {"type": "string"},
                    "duzeltmeler": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "mahalle", "sokak", "sokak_adaylari", "kapi_no", "daire", "kat", "bina", "ilce", "duzeltmeler"],
            },
        }
    },
    "required": ["items"],
}


def normalize_addresses(items, key, groq_key=None):
    """[{id, adres, ilce}] → her adres için düzeltilmiş mahalle/sokak/kapı no. Sonuç haritada ayrıca doğrulanmalı."""
    listing = "\n".join("[%s] %s (ilçe: %s)" % (i["id"], i["adres"], i.get("ilce", "")) for i in items)
    text = _generate([{"type": "text", "text": DUZELT_PROMPT + "\nAdresler:\n" + listing}], DUZELT_SCHEMA, key, groq_key=groq_key)
    try:
        out = _loose_json(text, "items")
    except (ValueError, KeyError, TypeError, IndexError):
        raise OkumaHatasi("Yapay zekâ yanıtı anlaşılamadı.", "response")
    ids = {str(i["id"]) for i in items}
    clean = []
    for r in out:
        if isinstance(r, dict) and str(r.get("id")) in ids:
            row = {k: str(r.get(k, "") or "").strip() for k in ("id", "mahalle", "sokak", "kapi_no", "daire", "kat", "bina", "ilce")}
            row["duzeltmeler"] = [str(x) for x in (r.get("duzeltmeler") or []) if x][:10]
            row["sokak_adaylari"] = [str(x).strip() for x in (r.get("sokak_adaylari") or []) if x][:3]
            clean.append(row)
    return clean


DENETIM_PROMPT = """Sen İstanbul'da kargo dağıtımı yapan bir sürücünün rota asistanısın.
Her durak için evrakta yazan adres ile haritada bulunan konum verilmiştir. Bulunan konumun gerçekten evraktaki adres olup olmadığını denetle.

durum:
- "hatali": bulunan yer başka bir ilçe (ilce_tutuyor=false) ya da açıkça başka bir mahalle/sokak; kapı numarası çok farklı (no_tutuyor=false).
- Uzaklık (en_yakin_km, merkez_km) tek başına hata sebebi DEĞİLDİR; yalnızca ilçe/mahalle de tutmuyorsa nedeni güçlendirir.
- ilce_tutuyor, mahalle_tutuyor ve no_tutuyor true ise durum her zaman "uygun"dur.
- Evrakta mahalle adının iki kez yazılması ("Caddebostan mah. Caddebostan Mahallesi"), mahallenin adresin başında ya da sonunda yazılması, ilçenin "Kadıköy Mah." gibi yazılması ve apartman/site adı HATA DEĞİLDİR. Yalnızca bulunan konum ile evraktaki sokak/kapı no/ilçe arasındaki gerçek farkları değerlendir.
- "kontrol": yalnızca sokak/mahalle düzeyinde (bina değil) bulunmuş; kapı numarası yok ya da tutmuyor; sokak adı benzer ama farklı yazılmış; AVM/site adı kesin eşleşmemiş.
- "uygun": ilçe, mahalle, sokak ve kapı numarası tutarlı (yazım farkları önemsiz: "Sok."="Sokak", "No:4"="4").

neden: Türkçe, en fazla 90 karakter, somut (ör. "Evrak Bostancı mah., bulunan Göztepe mah. ve 3 km uzakta").
oneri: yalnızca "hatali" ya da "kontrol" ise, haritada aranacak düzeltilmiş adres: "Sokak adı No, Mahalle, İlçe". Yalnızca evraktaki bilgiyi kullan, bariz yazım hatalarını düzelt, bilgi UYDURMA. "uygun" ise boş.
Yanıtı yalnızca JSON olarak ver."""

DENETIM_SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
    "id": {"type": "string"}, "durum": {"type": "string", "enum": ["uygun", "kontrol", "hatali"]}, "neden": {"type": "string"}, "oneri": {"type": "string"}},
    "required": ["id", "durum", "neden", "oneri"]}}}, "required": ["items"]}


def check_addresses(items, key, groq_key=None):
    """Evraktaki adres ↔ haritada bulunan konum karşılaştırması: [{id, durum: uygun|kontrol|hatali, neden, oneri}]."""
    text = _generate([{"type": "text", "text": DENETIM_PROMPT + "\n\nDuraklar (JSON):\n" + json.dumps(items, ensure_ascii=False)}], DENETIM_SCHEMA, key, groq_key=groq_key)
    try:
        out = _loose_json(text, "items")
    except (ValueError, KeyError, TypeError, IndexError):
        raise OkumaHatasi("Yapay zekâ yanıtı anlaşılamadı.", "response")
    ids = {str(i.get("id")) for i in items}
    clean = []
    for r in out:
        if isinstance(r, dict) and str(r.get("id")) in ids:
            durum = r.get("durum") if r.get("durum") in ("uygun", "kontrol", "hatali") else "kontrol"
            clean.append({"id": str(r["id"]), "durum": durum, "neden": str(r.get("neden") or "").strip()[:140],
                          "oneri": "" if durum == "uygun" else str(r.get("oneri") or "").strip()[:200]})
    return clean
