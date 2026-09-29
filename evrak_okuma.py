"""Evrak fotoğrafını Google Gemini ile okuyup teslimat satırlarına çevirir.

Anahtar yalnızca sunucuda durur (GEMINI_API_KEY ya da ayarlar.json "geminiKey").
Not: Gemini ücretsiz planında Google gönderilen içeriği ürün geliştirmede kullanabilir.
"""
import json
import os
import urllib.request

from providers import SSL_CONTEXT

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")

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
- Aynı satırı iki kez yazma."""

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
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=120, context=SSL_CONTEXT) as response:
        return json.load(response)


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


def read_document(image_b64, mime, key):
    """Fotoğraftaki tabloyu [{musteri, siparis_no, alici, not, adet, ilce, adres, geri_alim}] listesine çevirir."""
    import urllib.error
    try:
        data = _post("https://generativelanguage.googleapis.com/v1beta/interactions", {
            "model": MODEL,
            "input": [{"type": "text", "text": PROMPT}, {"type": "image", "data": image_b64, "mime_type": mime}],
            "response_format": {"type": "text", "mime_type": "application/json", "schema": SCHEMA},
            "generation_config": {"thinking_level": "low"},
        }, key)
        text = "".join(_texts(data.get("steps") or data.get("outputs") or data))
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise OkumaHatasi("Gemini anahtarı reddedildi. Anahtarı kontrol edin.", "auth")
        if error.code == 429:
            raise OkumaHatasi("Gemini ücretsiz kullanım sınırı doldu. Biraz sonra tekrar deneyin.", "quota")
        if error.code != 404:
            raise OkumaHatasi("Gemini geçici olarak hata verdi (HTTP %s)." % error.code)
        # Yeni uç nokta yoksa klasik generateContent ile dene
        data = _post("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % MODEL, {
            "contents": [{"parts": [{"text": PROMPT}, {"inline_data": {"mime_type": mime, "data": image_b64}}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA},
        }, key)
        text = "".join(_texts(data.get("candidates", [])))
    try:
        rows = json.loads(text)["rows"]
    except (ValueError, KeyError, TypeError):
        raise OkumaHatasi("Gemini yanıtı anlaşılamadı.", "response")
    clean = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        row = {k: str(r.get(k, "") or "").strip() for k in ("musteri", "siparis_no", "alici", "not", "adet", "ilce", "adres")}
        row["geri_alim"] = bool(r.get("geri_alim"))
        if len(row["adres"]) >= 6:
            clean.append(row)
    return clean
