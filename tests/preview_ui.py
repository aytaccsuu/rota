"""Ağ servisi çağırmadan örnek rotanın görsel kontrolü: python tests/preview_ui.py"""
import http.server
import json
from pathlib import Path
import re
import socketserver
import tempfile

source = (Path(__file__).resolve().parents[1] / 'index.html').read_text(encoding='utf-8')
source = re.sub(r'<script src="[^"]+"></script>', '', source)
boot = '''
depot={lat:40.96,lon:29.12};home={lat:41.05,lon:29.09};
stops=[
{id:5,lat:41.014,lon:29.087,mah:'Eğitim',ilce:'Kadıköy',quality:'Elle',raw:'Örnek Caddesi No: 25',orders:[{alici:'Örnek Müşteri E',adet:2}]},
{id:3,lat:40.982,lon:29.104,mah:'Göztepe',ilce:'Kadıköy',quality:'Elle',raw:'Örnek Sokak No: 17',orders:[{alici:'Örnek Müşteri C',adet:1}]},
{id:1,lat:40.973,lon:29.113,mah:'Göztepe',ilce:'Kadıköy',quality:'Elle',raw:'Örnek Sokak No: 3',orders:[{alici:'Örnek Müşteri A',adet:3}]},
{id:4,lat:41.008,lon:29.09,mah:'Eğitim',ilce:'Kadıköy',quality:'Elle',raw:'Örnek Caddesi No: 21',orders:[{alici:'Örnek Müşteri D',adet:1}]},
{id:2,lat:40.978,lon:29.108,mah:'Göztepe',ilce:'Kadıköy',quality:'Elle',raw:'Örnek Sokak No: 9',orders:[{alici:'Örnek Müşteri B',adet:2}]}];
getMatrix=async pts=>{const d=pts.map(a=>pts.map(b=>hav(a,b)*1300));return {dist:d,dur:d.map(r=>r.map(x=>x/8)),osrm:false}};
osrm=async()=>null;
$('fileInfo').textContent='Görsel test: karışık sırada 5 örnek kayıt';
$('setCard').style.display='none';
renderPts();renderStops();updateState();buildRoute();
'''
source=source.replace('renderPts();updateState();initMap();\nrefreshGoogleStatus();\nrenderEmpty();',boot)
source=source.replace('DAHA AZ YOL. DAHA DÜZENLİ DAĞITIM.','GÖRSEL TEST · ÖRNEK VERİLER')
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/ayarlar'):
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{}'); return
        super().do_GET()
    def log_message(self,*args):
        pass
with tempfile.TemporaryDirectory(prefix='rota-preview-') as folder:
    Path(folder,'index.html').write_text(source,encoding='utf-8')
    factory=lambda *a,**k: Handler(*a,directory=folder,**k)
    with socketserver.TCPServer(('127.0.0.1',8082),factory) as server:
        print('Görsel test: http://localhost:8082/index.html',flush=True)
        server.serve_forever()
