import importlib.util
import io
import json
import os
from pathlib import Path
import socketserver
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location('sunucu', Path(__file__).resolve().parents[1] / 'sunucu.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = str(Path(self.temp.name) / 'settings.json')
        Path(self.settings).write_text(json.dumps({'depot': {'lat': 41, 'lon': 29}, 'ykey': 'test-yandex'}), encoding='utf-8')
        self.file_patch = patch.object(app, 'AYAR', self.settings)
        self.file_patch.start()
        self.env_patch = patch.dict(os.environ, {}, clear=True)
        self.env_patch.start()
        self.server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.server.server_address[1])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.env_patch.stop()
        self.file_patch.stop()
        self.temp.cleanup()

    def request(self, path, body=None):
        req = urllib.request.Request(self.base+path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            text = response.read()
            try:
                data = json.loads(text)
            except ValueError:
                data = text
            return response.status, data

    def test_missing_key_and_private_settings(self):
        status, data = self.request('/api/google-search?q=Canpark')
        self.assertEqual(status, 503)
        self.assertIn('anahtarı', data['error'])
        self.assertEqual(self.request('/ayarlar.json')[0], 404)
        self.assertEqual(self.request('/sunucu.py')[0], 404)
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/api/google-search?q=x')[0], 400)

    def test_save_key_without_exposing_it(self):
        self.assertEqual(self.request('/ayarlar', {'gkey': 'test-secret'})[0], 204)
        status, data = self.request('/ayarlar')
        self.assertEqual(status, 200)
        self.assertTrue(data['googleConfigured'])
        self.assertNotIn('gkey', data)
        self.assertEqual(data['depot']['lat'], 41)
        self.assertEqual(app.read_settings()['gkey'], 'test-secret')
        self.assertEqual(self.request('/ayarlar', [1, 2])[0], 400)

    def test_google_proxy_success_and_failure(self):
        self.request('/ayarlar', {'gkey': 'test-secret'})
        with patch.object(app, 'google_search', return_value=[{'id':'canpark','displayName':{'text':'Canpark AVM'}}]) as search:
            status, data = self.request('/api/google-search?q=Canpark')
            self.assertEqual(status, 200)
            self.assertEqual(data['places'][0]['id'], 'canpark')
            search.assert_called_once_with('Canpark', 'test-secret')
        with patch.object(app, 'google_search', side_effect=urllib.error.HTTPError('url',403,'Denied',{},None)):
            status, data = self.request('/api/google-search?q=Canpark')
            self.assertEqual(status, 502)
            self.assertEqual(data['status'], 403)
        with patch.object(app, 'google_search', side_effect=TimeoutError()):
            self.assertEqual(self.request('/api/google-search?q=Canpark')[0], 502)

    def test_places_request_contract(self):
        response = io.BytesIO(b'{"places":[{"id":"canpark"}]}')
        with patch.object(app.urllib.request, 'urlopen', return_value=response) as call:
            self.assertEqual(app.google_search('Canpark AVM', 'secret')[0]['id'], 'canpark')
            req = call.call_args.args[0]
            self.assertEqual(req.full_url, 'https://places.googleapis.com/v1/places:searchText')
            self.assertEqual(req.get_method(), 'POST')
            body = json.loads(req.data)
            self.assertEqual(body['textQuery'], 'Canpark AVM')
            self.assertEqual(body['regionCode'], 'TR')
            self.assertEqual(req.get_header('X-goog-api-key'), 'secret')
            self.assertIn('places.location', req.get_header('X-goog-fieldmask'))

    def test_all_provider_keys_are_private_and_validated(self):
        fields = {v[1]: 'private-' + k for k, v in app.PROVIDERS.items()}
        self.assertEqual(self.request('/ayarlar', fields)[0], 204)
        status, data = self.request('/ayarlar')
        self.assertEqual(status, 200)
        self.assertTrue(all(data['providers'].values()))
        self.assertTrue(all(k not in data for k in fields))
        self.assertEqual(self.request('/ayarlar', {'tomtomKey': {'bad': 1}})[0], 400)

    def test_provider_errors_and_routing(self):
        self.assertEqual(self.request('/api/location-search?provider=unknown&q=Istanbul')[0], 400)
        self.assertEqual(self.request('/api/location-search?provider=tomtom&q=Istanbul')[1]['code'], 'missing_key')
        for provider, (_, field, _) in app.PROVIDERS.items():
            self.request('/ayarlar', {field:'secret'})
            url = '/api/location-search?provider='+provider+'&q=Canpark&mode=place'
            with patch.object(app, 'provider_search', return_value=[]) as call:
                self.assertEqual(self.request(url), (200, {'candidates': []}))
                call.assert_called_once_with(provider, 'Canpark', 'secret', 'place')
            for status, code in [(403,'auth'), (429,'quota'), (500,'upstream')]:
                with patch.object(app, 'provider_search', side_effect=urllib.error.HTTPError('secret-url',status,'secret',{},None)):
                    result = self.request(url)
                    self.assertEqual(result[1]['code'], code)
                    self.assertNotIn('secret', json.dumps(result))
            with patch.object(app, 'provider_search', side_effect=TimeoutError()):
                self.assertEqual(self.request(url)[1]['code'], 'network')

if __name__ == '__main__':
    unittest.main()
