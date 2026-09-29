"""Giriş ekranı ve oturum testleri."""
import http.client
import importlib.util
import json
import socketserver
import threading
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sunucu', Path(__file__).resolve().parents[1] / 'sunucu.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class GirisTests(unittest.TestCase):
    def setUp(self):
        self.patches = [patch.object(app, 'USERS', {'mesut': 'Gizli-Sifre-1', 'ali': 'baska'}), patch.object(app, 'SIFRE', ''),
                        patch.object(app, 'FAILS', {})]
        for p in self.patches:
            p.start()
        self.server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), app.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        for p in self.patches:
            p.stop()

    def req(self, method, path, body=None, cookie=None, form=False):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        headers = {}
        if cookie:
            headers['Cookie'] = cookie
        if form:
            body = urllib.parse.urlencode(body)
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict(r.getheaders()), data

    def login(self, name, pw):
        return self.req('POST', '/giris', {'kullanici': name, 'sifre': pw}, form=True)

    def test_page_redirects_to_login_and_api_is_401(self):
        status, headers, _ = self.req('GET', '/')
        self.assertEqual(status, 303)
        self.assertEqual(headers['Location'], '/giris')
        status, _, body = self.req('GET', '/giris')
        self.assertEqual(status, 200)
        self.assertIn('Giriş yap'.encode(), body)
        for path in ('/ayarlar', '/api/location-search?provider=tomtom&q=Kadikoy'):
            status, _, body = self.req('GET', path)
            self.assertEqual(status, 401)
            self.assertEqual(json.loads(body)['code'], 'login')
        self.assertEqual(self.req('POST', '/api/ocr', b'{}')[0], 401)
        self.assertEqual(self.req('HEAD', '/')[0], 401)

    def test_login_sets_session_and_logout_clears(self):
        status, headers, _ = self.login('Mesut', 'Gizli-Sifre-1')  # kullanıcı adı büyük/küçük harf duyarsız
        self.assertEqual(status, 303)
        self.assertEqual(headers['Location'], '/')
        cookie = headers['Set-Cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Lax', cookie)
        token = cookie.split(';')[0]
        status, _, body = self.req('GET', '/ayarlar', cookie=token)
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data['user'], 'mesut')
        self.assertTrue(data['authOn'])
        self.assertEqual(self.req('GET', '/', cookie=token)[0], 200)
        self.assertEqual(self.req('GET', '/giris', cookie=token)[1].get('Location'), '/', 'girişliyken giriş sayfası ana sayfaya yönlendirir')
        status, headers, _ = self.req('GET', '/cikis', cookie=token)
        self.assertIn('Max-Age=0', headers['Set-Cookie'])

    def test_wrong_password_and_lockout(self):
        for _ in range(4):
            self.assertEqual(self.login('mesut', 'yanlis')[1]['Location'], '/giris?hata=1')
        self.assertEqual(self.login('mesut', 'yanlis')[1]['Location'], '/giris?hata=kilit')
        # kilitliyken doğru şifre de kabul edilmez
        self.assertEqual(self.login('mesut', 'Gizli-Sifre-1')[1]['Location'], '/giris?hata=kilit')
        self.assertEqual(self.login('olmayan', 'x')[1]['Location'], '/giris?hata=kilit')

    def test_forged_expired_or_removed_user_token(self):
        self.assertEqual(self.req('GET', '/ayarlar', cookie='rota_oturum=bozuk')[0], 401)
        forged = app.make_token('mesut').replace('A', 'B', 1)
        self.assertEqual(self.req('GET', '/ayarlar', cookie='rota_oturum=' + forged)[0], 401)
        expired = app.make_token('mesut', now=1)
        self.assertIsNone(app.read_token(expired))
        token = app.make_token('ali')
        self.assertEqual(app.read_token(token), 'ali')
        with patch.object(app, 'USERS', {'mesut': 'Gizli-Sifre-1'}):
            self.assertIsNone(app.read_token(token), 'silinen kullanıcının oturumu geçersiz')

    def test_parse_users(self):
        self.assertEqual(app.parse_users(' Mesut:a:b , ali:x; bos:, :y'), {'mesut': 'a:b', 'ali': 'x'})


class YerelTests(unittest.TestCase):
    def test_no_users_means_no_login(self):
        with patch.object(app, 'USERS', {}), patch.object(app, 'SIFRE', ''):
            self.assertFalse(app.auth_enabled())


if __name__ == '__main__':
    unittest.main()
