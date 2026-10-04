"""Address provider adapters. Keys and upstream error bodies never reach clients."""
import json
import re
import math
import os
import ssl
import urllib.parse
import urllib.request

PROVIDERS = {
    'yandex': ('Yandex', 'ygeokey', 'YANDEX_GEOCODER_API_KEY'),
    'geoapify': ('Geoapify', 'geoapifyKey', 'GEOAPIFY_API_KEY'),
    'tomtom': ('TomTom', 'tomtomKey', 'TOMTOM_API_KEY'),
    'maptiler': ('MapTiler', 'maptilerKey', 'MAPTILER_API_KEY'),
}


def key_for(provider, settings):
    _, field, env = PROVIDERS[provider]
    return os.environ.get(env) or settings.get(field) or (settings.get('ykey') if provider == 'yandex' else '')


def _ssl_context():
    """Windows kök sertifika deposu eksik olabilir (ör. TomTom'un IdenTrust kökü); varsa certifi listesi de eklenir."""
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except (ImportError, OSError):
        pass
    return ctx


SSL_CONTEXT = _ssl_context()


def get_json(url, params):
    req = urllib.request.Request(url + '?' + urllib.parse.urlencode(params), headers={'User-Agent': 'RotaPlan/1.0'})
    with urllib.request.urlopen(req, timeout=12, context=SSL_CONTEXT) as response:
        return json.load(response)


def candidate(source, lat, lon, *, name='', road='', no='', areas=(), address='', precise=False, poi=False, precision='', dataset=''):
    areas = [str(x) for x in areas if x]
    return dict(source=source, lat=lat, lon=lon, name=name or address, road=road, no=no,
                areas=areas, mah='', ilce='', address=address, precision='exact' if precise else precision or 'approximate',
                type='poi' if poi else 'house' if no else 'street' if road else 'area',
                types=['establishment'] if poi else ['street_address'] if no else ['route'] if road else ['locality'],
                dataset=dataset or source,
                url='https://www.openstreetmap.org/?' + urllib.parse.urlencode({'mlat': lat, 'mlon': lon}))


def provider_search(provider, query, key, mode='address'):
    out = []
    if provider == 'yandex':
        # mode='reverse': query "boylam,enlem"; o noktadaki binalar (kind=house) en yakından başlayarak
        params = dict(apikey=key, geocode=query, lang='tr_TR', format='json', results=10, kind='house') if mode == 'reverse' else dict(apikey=key, geocode=query, lang='tr_TR', format='json', results=10, bbox='27.9,40.7~29.95,41.6', rspn=1)
        data = get_json('https://geocode-maps.yandex.ru/v1/', params)
        for item in data['response']['GeoObjectCollection']['featureMember']:
            g = item['GeoObject']; md = g['metaDataProperty']['GeocoderMetaData']
            parts = md.get('Address', {}).get('Components', [])
            by = lambda kind: next((c['name'] for c in parts if c['kind'] == kind), '')
            lon, lat = map(float, g['Point']['pos'].split())
            out.append(candidate('Yandex', lat, lon, name=g.get('name',''), road=by('street'), no=re.sub(r'^\s*(?:no|№)\s*[:.]?\s*', '', by('house'), flags=re.I), areas=[c['name'] for c in parts if c['kind'] != 'house'], address=md.get('text',''), precise=md.get('kind') == 'house' and md.get('precision') == 'exact', precision=md.get('precision','')))
    elif provider == 'geoapify':
        data = get_json('https://api.geoapify.com/v1/geocode/search', dict(apiKey=key, text=query, lang='tr', format='json', limit=10, filter='rect:27.9,40.7,29.95,41.6'))
        for p in data['results']:
            rank = p.get('rank', {})
            out.append(candidate('Geoapify', p.get('lat'), p.get('lon'), name=p.get('name',''), road=p.get('street',''), no=p.get('housenumber',''), areas=[p.get(k) for k in ('suburb','district','city','county','state')], address=p.get('formatted',''), precise=bool(p.get('housenumber')) and rank.get('confidence_building_level',0) >= .95 and rank.get('match_type') == 'full_match', poi=p.get('result_type') == 'amenity', dataset=p.get('datasource',{}).get('sourcename','Geoapify')))
    elif provider == 'tomtom':
        data = get_json('https://api.tomtom.com/search/2/search/' + urllib.parse.quote(query, safe='') + '.json', dict(key=key, language='tr-TR', countrySet='TR', limit=10, lat=41, lon=29.05))
        for p in data['results']:
            a = p.get('address', {}); pos = p.get('position', {})
            out.append(candidate('TomTom', pos.get('lat'), pos.get('lon'), name=p.get('poi',{}).get('name',''), road=a.get('streetName',''), no=a.get('streetNumber',''), areas=[a.get(k) for k in ('municipalitySecondarySubdivision','municipalitySubdivision','municipality','countrySecondarySubdivision','countrySubdivision')], address=a.get('freeformAddress',''), precise=p.get('type') == 'Point Address', poi=p.get('type') == 'POI'))
    elif provider == 'maptiler':
        data = get_json('https://api.maptiler.com/geocoding/' + urllib.parse.quote(query, safe='') + '.json', dict(key=key, language='tr', country='tr', limit=10, bbox='27.9,40.7,29.95,41.6', proximity='29.05,41'))
        for f in data['features']:
            lon, lat = f['center']; p = f.get('properties', {}); types = f.get('place_type', [])
            is_addr = 'address' in types; no = str(f.get('address', '')) if is_addr else ''
            # "virtual_street": bina kaydı yok, numara sokak üzerinde tahmin edilmiş → kesin sayılmaz
            out.append(candidate('MapTiler', lat, lon, name=f.get('text', ''), road=f.get('text', '') if is_addr else '', no=no, areas=[c.get('text') for c in f.get('context', []) if not c.get('id', '').startswith('postal_code')], address=f.get('place_name', ''), precise=bool(no) and p.get('kind') != 'virtual_street' and f.get('relevance', 0) >= .9, poi='poi' in types, dataset='MapTiler (OpenStreetMap)'))
    return [c for c in out if all(isinstance(c[k], (float,int)) and not isinstance(c[k],bool) and math.isfinite(c[k]) for k in ('lat','lon')) and 40.7 <= c['lat'] <= 41.6 and 27.9 <= c['lon'] <= 29.95]
