"""Plan kaydı: dosya ve PostgreSQL arka ucu, kullanıcıya göre ayrım."""
import http.client
import importlib.util
import json
import os
import socketserver
import sys
import tempfile
import threading
import types
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

import depo

spec = importlib.util.spec_from_file_location('sunucu', Path(__file__).resolve().parents[1] / 'sunucu.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class DosyaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = [patch.object(depo, 'PLAN_DIR', self.tmp.name), patch.dict(os.environ, {'DATABASE_URL': ''})]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        self.tmp.cleanup()

    def test_save_load_delete_per_user(self):
        self.assertEqual(depo.backend(), 'dosya')
        depo.save('Mesut', json.dumps({'v': 1, 'stops': [1]}))
        depo.save('ali', json.dumps({'v': 1, 'stops': [2]}))
        self.assertEqual(json.loads(depo.load('mesut'))['stops'], [1], 'kullanıcı adı büyük/küçük harf duyarsız')
        self.assertEqual(json.loads(depo.load('ali'))['stops'], [2])
        depo.save('mesut', None)
        self.assertIsNone(depo.load('mesut'))
        self.assertIsNotNone(depo.load('ali'))
        with self.assertRaises(ValueError):
            depo.save('ali', 'bozuk json')

    def test_unsafe_user_name(self):
        depo.save('../../etc', json.dumps({'v': 1}))
        self.assertTrue(all(os.path.dirname(os.path.join(self.tmp.name, f)) == self.tmp.name for f in os.listdir(self.tmp.name)))


class PostgresTests(unittest.TestCase):
    """psycopg yerine sahte bir sürücüyle SQL akışını doğrular."""
    def setUp(self):
        self.sql = []
        test = self

        class Cur:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def execute(self, q, params=()): test.sql.append((' '.join(q.split()), params)); self.last = (q, params)
            def fetchone(self):
                q, params = self.last
                return (test.store[params[0]],) if params[0] in test.store else None

        class Conn:
            def cursor(self): return Cur()
            def close(self): pass

        self.store = {'mesut': '{"v": 1}'}
        fake = types.SimpleNamespace(connect=lambda *a, **k: Conn(), Error=Exception)
        self.p = [patch.dict(sys.modules, {'psycopg': fake}), patch.dict(os.environ, {'DATABASE_URL': 'postgresql://x'}), patch.object(depo, '_ready', False)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()

    def test_schema_once_and_upsert(self):
        self.assertEqual(depo.backend(), 'postgres')
        self.assertEqual(depo.load('Mesut'), '{"v": 1}')
        depo.save('mesut', '{"v": 2}')
        depo.save('mesut', None)
        creates = [q for q, _ in self.sql if q.startswith('CREATE ')]
        self.assertEqual(len(creates), len(depo.SCHEMA), 'tablo oluşturma yalnızca ilk bağlantıda')
        self.assertTrue(any('ON CONFLICT (kullanici) DO UPDATE' in q and p == ('mesut', '{"v": 2}') for q, p in self.sql))
        self.assertTrue(any(q.startswith('DELETE FROM planlar') for q, _ in self.sql))


class PlanEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = [patch.object(depo, 'PLAN_DIR', self.tmp.name), patch.dict(os.environ, {'DATABASE_URL': ''}),
                  patch.object(app, 'USERS', {'mesut': 'a', 'ali': 'b'}), patch.object(app, 'SIFRE', ''), patch.object(app, 'FAILS', {})]
        for x in self.p:
            x.start()
        self.server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), app.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        for x in self.p:
            x.stop()
        self.tmp.cleanup()

    def req(self, method, path, body=None, cookie=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        headers = {'Content-Type': 'application/json'}
        if cookie:
            headers['Cookie'] = cookie
        c.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, (json.loads(data) if data else None)

    def test_plans_are_private_per_user(self):
        mesut = 'rota_oturum=' + app.make_token('mesut')
        ali = 'rota_oturum=' + app.make_token('ali')
        self.assertEqual(self.req('GET', '/api/plan')[0], 401, 'oturumsuz plan okunamaz')
        self.assertEqual(self.req('POST', '/api/plan', {'plan': {'v': 1, 'stops': [{'id': 1}]}}, mesut)[0], 204)
        status, data = self.req('GET', '/api/plan', cookie=mesut)
        self.assertEqual(json.loads(data['plan'])['stops'][0]['id'], 1)
        self.assertIsNone(self.req('GET', '/api/plan', cookie=ali)[1]['plan'], 'başka kullanıcının planı görünmez')
        self.assertEqual(self.req('POST', '/api/plan', {'plan': 'metin'}, mesut)[0], 400)
        self.assertEqual(self.req('POST', '/api/plan', {'plan': None}, mesut)[0], 204)
        self.assertIsNone(self.req('GET', '/api/plan', cookie=mesut)[1]['plan'])


    def test_fiyat_rut_yakit_evrak(self):
        import base64
        mesut = 'rota_oturum=' + app.make_token('mesut')
        ali = 'rota_oturum=' + app.make_token('ali')
        f = {'anadolu': [{'nokta': 20, 'tl': 5000}, {'nokta': 18, 'tl': 5000}], 'avrupa1': [{'nokta': 18, 'tl': 5800}, {'nokta': 16, 'tl': 5800}],
             'avrupa2': [{'nokta': 18, 'tl': 6100}, {'nokta': 16, 'tl': 6100}], 'ekstraNokta': 150, 'kdv': 20, 'kmUcret': 12}
        self.assertEqual(self.req('POST', '/api/fiyat', {'fiyat': f}, mesut)[0], 204)
        self.assertEqual(self.req('GET', '/api/fiyat', cookie=ali)[1]['fiyat']['kmUcret'], 12, 'fiyat tablosu ortak')
        self.assertEqual(self.req('POST', '/api/fiyat', {'fiyat': {'anadolu': []}}, mesut)[0], 400)
        # günlük kayıt: aynı gün tekrar yazılınca güncellenir
        self.assertEqual(self.req('POST', '/api/rut', {'tarih': '2026-10-01', 'rut': {'durum': 'calisti', 'hammaliye': 100}}, mesut)[0], 204)
        self.assertEqual(self.req('POST', '/api/rut', {'tarih': '2026-10-01', 'rut': {'durum': 'calisti', 'hammaliye': 250}}, mesut)[0], 204)
        self.assertEqual(self.req('POST', '/api/rut', {'tarih': '2026-10-02', 'rut': {'durum': 'gidilmedi', 'neden': 'İzin'}}, mesut)[0], 204)
        rutlar = self.req('GET', '/api/rutlar?ay=2026-10', cookie=mesut)[1]['rutlar']
        self.assertEqual([(r['tarih'], r.get('hammaliye'), r['durum']) for r in rutlar], [('2026-10-01', 250, 'calisti'), ('2026-10-02', None, 'gidilmedi')])
        self.assertEqual(self.req('GET', '/api/rutlar?ay=2026-10', cookie=ali)[1]['rutlar'], [], 'başkasının kaydı görünmez')
        self.assertEqual(self.req('POST', '/api/rut', {'tarih': '01.10.2026', 'rut': {}}, mesut)[0], 400)
        # yakıt: ekle, güncelle, sil
        yid = self.req('POST', '/api/yakit', {'tarih': '2026-10-01', 'tutar': 2500, 'litre': 55.5, 'km': 120000}, mesut)[1]['id']
        self.req('POST', '/api/yakit', {'id': yid, 'tarih': '2026-10-01', 'tutar': 2600}, mesut)
        self.req('POST', '/api/yakit', {'tarih': '2026-10-03', 'tutar': 1000}, mesut)
        y = self.req('GET', '/api/yakitlar?ay=2026-10', cookie=mesut)[1]['yakitlar']
        self.assertEqual([x['tutar'] for x in y], [2600, 1000])
        self.assertEqual(self.req('POST', '/api/yakit', {'tarih': '2026-10-01', 'tutar': -5}, mesut)[0], 400)
        self.req('POST', '/api/yakit-sil', {'id': yid}, ali)  # başkası silemez
        self.assertEqual(len(self.req('GET', '/api/yakitlar?ay=2026-10', cookie=mesut)[1]['yakitlar']), 2)
        self.req('POST', '/api/yakit-sil', {'id': yid}, mesut)
        self.assertEqual(len(self.req('GET', '/api/yakitlar?ay=2026-10', cookie=mesut)[1]['yakitlar']), 1)
        # evrak: yükle ve sadece sahibi görsün
        eid = self.req('POST', '/api/evrak', {'tarih': '2026-10-01', 'ad': 'e.jpg', 'mime': 'image/jpeg', 'data': base64.b64encode(b'JPEGDATA').decode()}, mesut)[1]['id']
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        c.request('GET', '/api/evrak/%d' % eid, headers={'Cookie': mesut}); r = c.getresponse(); body = r.read(); c.close()
        self.assertEqual((r.status, r.getheader('Content-Type'), body), (200, 'image/jpeg', b'JPEGDATA'))
        self.assertEqual(self.req('GET', '/api/evrak/%d' % eid, cookie=ali)[0], 404)
        self.assertEqual(self.req('POST', '/api/evrak', {'tarih': '2026-10-01', 'ad': 'x', 'mime': 'text/html', 'data': 'aGk='}, mesut)[0], 400)
        # rota silme: günün kaydı ve evrakları birlikte silinir, başka gün etkilenmez
        self.assertEqual(self.req('POST', '/api/rut', {'tarih': '2026-10-01', 'rut': None, 'evraklar': 'sil'}, mesut)[0], 204)
        self.assertEqual([r['tarih'] for r in self.req('GET', '/api/rutlar?ay=2026-10', cookie=mesut)[1]['rutlar']], ['2026-10-02'])
        self.assertEqual(self.req('GET', '/api/evrak/%d' % eid, cookie=mesut)[0], 404)


    def login(self, name, pw):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        c.request('POST', '/giris', body='kullanici=%s&sifre=%s' % (name, pw), headers={'Content-Type': 'application/x-www-form-urlencoded'})
        r = c.getresponse(); r.read(); c.close()
        cookie = (r.getheader('Set-Cookie') or '').split(';')[0]
        return cookie if cookie.startswith('rota_oturum=') and len(cookie) > 15 else None

    def test_yonetici_kullanici_yonetimi(self):
        mesut = 'rota_oturum=' + app.make_token('mesut')  # ilk kullanıcı → yönetici
        ali = 'rota_oturum=' + app.make_token('ali')
        self.assertTrue(self.req('GET', '/ayarlar', cookie=mesut)[1]['isAdmin'])
        self.assertFalse(self.req('GET', '/ayarlar', cookie=ali)[1]['isAdmin'])
        self.assertEqual(self.req('GET', '/api/kullanicilar', cookie=ali)[0], 403)
        self.assertEqual(self.req('POST', '/api/kullanici', {'ad': 'veli', 'sifre': 'Gizli-123'}, ali)[0], 403)
        self.assertEqual(self.req('POST', '/api/fiyat', {'fiyat': {}}, ali)[0], 403, 'fiyatı yalnızca yönetici değiştirir')
        self.assertEqual(self.req('POST', '/ayarlar', {'tomtomKey': 'x'}, ali)[0], 403, 'anahtarları yalnızca yönetici değiştirir')
        # ekle → giriş yapabilir
        status, data = self.req('POST', '/api/kullanici', {'ad': 'Veli', 'sifre': 'Gizli-123'}, mesut)
        self.assertEqual(status, 200)
        self.assertIn({'ad': 'veli', 'sabit': False, 'yonetici': False}, [{k: r[k] for k in ('ad', 'sabit', 'yonetici')} for r in data['kullanicilar']])
        self.assertIsNone(self.login('veli', 'yanlis-sifre'))
        veli = self.login('veli', 'Gizli-123')
        self.assertTrue(veli)
        self.assertEqual(self.req('GET', '/api/plan', cookie=veli)[0], 200)
        self.assertEqual(self.req('POST', '/api/kullanici', {'ad': 'ali', 'sifre': 'Gizli-123'}, mesut)[0], 400, 'sabit kullanıcı değiştirilemez')
        self.assertEqual(self.req('POST', '/api/kullanici', {'ad': 'vel', 'sifre': '123'}, mesut)[0], 400, 'kısa şifre')
        self.assertEqual(self.req('POST', '/api/kullanici', {'ad': 'ayşe', 'sifre': 'Gizli-123'}, mesut)[0], 200)
        self.assertEqual(self.req('POST', '/api/kullanici', {'ad': 'ayçe', 'sifre': 'Gizli-123'}, mesut)[0], 400, 'kayıt anahtarı çakışan ad (ikisi de ay_e)')
        # depo/ev kişiye özel
        self.req('POST', '/ayarlar', {'home': {'lat': 41.1, 'lon': 29.1}}, veli)
        self.assertEqual(self.req('GET', '/ayarlar', cookie=veli)[1]['home'], {'lat': 41.1, 'lon': 29.1})
        self.assertNotEqual(self.req('GET', '/ayarlar', cookie=ali)[1].get('home'), {'lat': 41.1, 'lon': 29.1}, 'başkasının evi görünmez')
        # şifre değişince eski oturum düşer; silinince giriş yapılamaz
        self.req('POST', '/api/rut', {'tarih': '2026-10-01', 'rut': {'durum': 'calisti'}}, veli)
        self.assertEqual(self.req('POST', '/api/kullanici', {'ad': 'veli', 'sifre': 'Yeni-4567'}, mesut)[0], 200)
        self.assertEqual(self.req('GET', '/api/plan', cookie=veli)[0], 401)
        veli = self.login('veli', 'Yeni-4567')
        self.assertEqual(self.req('POST', '/api/kullanici-sil', {'ad': 'veli', 'veriler': True}, mesut)[0], 200)
        self.assertEqual(self.req('GET', '/api/plan', cookie=veli)[0], 401)
        self.assertIsNone(self.login('veli', 'Yeni-4567'))
        app.USERS['veli'] = 'x'
        try:
            self.assertEqual(self.req('GET', '/api/rutlar?ay=2026-10', cookie='rota_oturum=' + app.make_token('veli'))[1]['rutlar'], [], 'verileri de silindi')
        finally:
            del app.USERS['veli']


class YoneticiTests(unittest.TestCase):
    def test_aytac_yonetici(self):
        with patch.dict(os.environ, {'ROTA_YONETICI': ''}), patch.object(app, 'USERS', {'mesut': 'a', 'aytac': 'b'}):
            self.assertEqual(app.admins(), {'aytac'})
            self.assertTrue(app.is_admin('aytac'))
            self.assertFalse(app.is_admin('mesut'))
        with patch.dict(os.environ, {'ROTA_YONETICI': ''}), patch.object(app, 'USERS', {'mesut': 'a', 'ali': 'b'}):
            self.assertEqual(app.admins(), {'mesut'}, 'aytac yoksa ilk kullanıcı')
        with patch.dict(os.environ, {'ROTA_YONETICI': 'ali'}), patch.object(app, 'USERS', {'aytac': 'a', 'ali': 'b'}):
            self.assertEqual(app.admins(), {'ali'})


if __name__ == '__main__':
    unittest.main()
