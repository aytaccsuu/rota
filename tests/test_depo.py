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
        creates = [q for q, _ in self.sql if q.startswith('CREATE TABLE')]
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


if __name__ == '__main__':
    unittest.main()
