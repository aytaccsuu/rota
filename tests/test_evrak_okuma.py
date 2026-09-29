import json
import unittest
import urllib.error
from unittest.mock import patch

import evrak_okuma as ev

ROWS = {"rows": [
    {"musteri": "IKEA", "siparis_no": "162009265697326", "alici": "Esra Kutsal", "not": "2 parça teslim olsun",
     "adet": "", "ilce": "KADIKÖY", "adres": "Göztepe mah. Tepegöz Sk. Utku Apt. No:49/21 Kat:11", "geri_alim": False},
    {"musteri": "IKEA", "siparis_no": "1", "alici": "x", "not": "", "adet": "", "ilce": "", "adres": "kısa", "geri_alim": False},
]}


class EvrakOkumaTests(unittest.TestCase):
    def test_interactions_response(self):
        reply = {"steps": [{"content": [{"type": "text", "text": json.dumps(ROWS, ensure_ascii=False)}]}]}
        with patch.object(ev, "_post", return_value=reply) as call:
            rows = ev.read_document("aGVsbG8=" * 20, "image/jpeg", "secret")
        self.assertEqual(len(rows), 1, "adresi 6 karakterden kısa satır atılmalı")
        self.assertEqual(rows[0]["alici"], "Esra Kutsal")
        self.assertEqual(rows[0]["not"], "2 parça teslim olsun")
        self.assertIn("/interactions", call.call_args.args[0])
        self.assertNotIn("secret", json.dumps(call.call_args.args[1]))

    def test_model_chain_on_quota(self):
        ok = {"steps": [{"content": [{"type": "text", "text": json.dumps(ROWS)}]}]}
        quota = urllib.error.HTTPError("u", 429, "quota", {}, None)
        with patch.object(ev, "_post", side_effect=[quota, ok]) as call:
            rows = ev.read_document("aGVsbG8=" * 20, "image/jpeg", "secret")
        self.assertEqual(rows[0]["siparis_no"], "162009265697326")
        self.assertEqual([c.args[1]["model"] for c in call.call_args_list], ev.OCR_MODELS[:2], "kota dolunca sıradaki model")
        self.assertEqual(call.call_args_list[0].args[1]["input"][1]["resolution"], "ultra_high")
        self.assertTrue(all(not m.startswith("gemini-2.") for m in ev.OCR_MODELS))

    def test_thinking_param_rejected(self):
        ok = {"steps": [{"content": [{"type": "text", "text": json.dumps(ROWS)}]}]}
        bad = urllib.error.HTTPError("u", 400, "bad", {}, None)
        with patch.object(ev, "_post", side_effect=[bad, ok]) as call:
            ev.read_document("aGVsbG8=" * 20, "image/jpeg", "k")
        self.assertNotIn("generation_config", call.call_args_list[1].args[1])

    def test_schema_ignored_fenced_list(self):
        fenced = "```json\n" + json.dumps([{"musteri": "IKEA", "siparis_numarasi": "162609260066936", "alici": "Berna Gülsan",
                                               "adet": "1", "ilce": "KADIKÖY", "adres": "Bostancı mah. Bahçelerarası sok no4", "not": "", "geri_alim": False}], ensure_ascii=False) + "\n```"
        with patch.object(ev, "_post", return_value={"steps": [{"content": [{"type": "text", "text": fenced}]}]}):
            rows = ev.read_document("aGVsbG8=" * 20, "image/jpeg", "k")
        self.assertEqual(rows[0]["siparis_no"], "162609260066936")
        self.assertEqual(rows[0]["alici"], "Berna Gülsan")

    def test_errors(self):
        for code, kind in ((403, "auth"), (429, "quota"), (500, "upstream")):
            with patch.object(ev, "_post", side_effect=urllib.error.HTTPError("u", code, "x", {}, None)):
                with self.assertRaises(ev.OkumaHatasi) as ctx:
                    ev.read_document("aGVsbG8=" * 20, "image/jpeg", "k")
                self.assertEqual(ctx.exception.code, kind)
        with patch.object(ev, "_post", return_value={"steps": [{"content": [{"type": "text", "text": "not json"}]}]}):
            with self.assertRaises(ev.OkumaHatasi):
                ev.read_document("aGVsbG8=" * 20, "image/jpeg", "k")

    def test_normalize_addresses_filters_unknown_ids(self):
        out = {"items": [
            {"id": "1", "mahalle": "Göztepe", "sokak": "Tünelc Sokak", "sokak_adaylari": ["Tünek Sokak"], "kapi_no": "17",
             "daire": "27", "kat": "14", "bina": "Fidem Prestij Apt.", "ilce": "Kadıköy", "duzeltmeler": ["Sok. → Sokak"]},
            {"id": "99", "mahalle": "", "sokak": "Uydurma", "sokak_adaylari": [], "kapi_no": "", "daire": "", "kat": "", "bina": "", "ilce": "", "duzeltmeler": []}]}
        reply = {"steps": [{"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}]}
        with patch.object(ev, "_post", return_value=reply):
            rows = ev.normalize_addresses([{"id": "1", "adres": "Göztepe mah. Tünelc Sok. No:17", "ilce": "Kadıköy"}], "k")
        self.assertEqual([r["id"] for r in rows], ["1"], "istenmeyen kimlikli satır atılmalı")
        self.assertEqual(rows[0]["sokak_adaylari"], ["Tünek Sokak"])

    def test_retry_on_overload(self):
        calls = []
        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b'{"ok": 1}'
        def fake(req, timeout, context):
            calls.append(1)
            if len(calls) < 2:
                raise urllib.error.HTTPError("u", 503, "busy", {}, None)
            return Resp()
        with patch("urllib.request.urlopen", side_effect=fake), patch("time.sleep"):
            self.assertEqual(ev._post("https://x", {}, "k"), {"ok": 1})
        self.assertEqual(len(calls), 2, 'geçici hatada bir kez tekrar, sonra sıradaki model')


if __name__ == "__main__":
    unittest.main()
