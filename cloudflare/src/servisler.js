// Adres servisleri (Yandex, Geoapify, TomTom, MapTiler), TomTom trafik/rota ve openrouteservice yedeği
import { onbellekAl, onbellekKoy } from './ortak.js';

export const PROVIDERS = {
  yandex: ['Yandex', 'ygeokey', 'YANDEX_GEOCODER_API_KEY'],
  geoapify: ['Geoapify', 'geoapifyKey', 'GEOAPIFY_API_KEY'],
  tomtom: ['TomTom', 'tomtomKey', 'TOMTOM_API_KEY'],
  maptiler: ['MapTiler', 'maptilerKey', 'MAPTILER_API_KEY'],
};
export const anahtar = (env, ayar, p) => {
  const [, alan, ortam] = PROVIDERS[p];
  return env[ortam] || ayar[alan] || (p === 'yandex' ? (env.YANDEX_MAPS_JS_KEY || ayar.ykey || '') : '');
};

export class ServisHatasi extends Error { constructor(status, mesaj) { super(mesaj || 'hata ' + status); this.status = status; } }

async function getJson(url, params, zaman = 12000) {
  const r = await fetch(url + '?' + new URLSearchParams(params), { headers: { 'User-Agent': 'RotaPlan/1.0' }, signal: AbortSignal.timeout(zaman) });
  if (!r.ok) throw new ServisHatasi(r.status);
  return r.json();
}
async function postJson(url, body, basliklar = {}, zaman = 60000) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'RotaPlan/1.0', ...basliklar }, body: JSON.stringify(body), signal: AbortSignal.timeout(zaman) });
  if (!r.ok) throw new ServisHatasi(r.status);
  return r.json();
}

function aday(source, lat, lon, { name = '', road = '', no = '', areas = [], address = '', precise = false, poi = false, precision = '', dataset = '' } = {}) {
  areas = areas.filter(Boolean).map(String);
  return {
    source, lat, lon, name: name || address, road, no, areas, mah: '', ilce: '', address,
    precision: precise ? 'exact' : precision || 'approximate',
    type: poi ? 'poi' : no ? 'house' : road ? 'street' : 'area',
    types: poi ? ['establishment'] : no ? ['street_address'] : road ? ['route'] : ['locality'],
    dataset: dataset || source, url: 'https://www.openstreetmap.org/?' + new URLSearchParams({ mlat: lat, mlon: lon }),
  };
}

export async function adresAra(p, sorgu, key, mode = 'address') {
  const out = [];
  if (p === 'yandex') {
    // mode='reverse': sorgu "boylam,enlem"; o noktadaki binalar (kind=house)
    const d = await getJson('https://geocode-maps.yandex.ru/v1/', mode === 'reverse' ? { apikey: key, geocode: sorgu, lang: 'tr_TR', format: 'json', results: 10, kind: 'house' } : { apikey: key, geocode: sorgu, lang: 'tr_TR', format: 'json', results: 10, bbox: '27.9,40.7~29.95,41.6', rspn: 1 });
    for (const item of d.response.GeoObjectCollection.featureMember) {
      const g = item.GeoObject, md = g.metaDataProperty.GeocoderMetaData, parts = md.Address?.Components || [];
      const by = k => parts.find(c => c.kind === k)?.name || '';
      const [lon, lat] = g.Point.pos.split(' ').map(Number);
      out.push(aday('Yandex', lat, lon, { name: g.name || '', road: by('street'), no: by('house').replace(/^\s*(?:no|№)\s*[:.]?\s*/i, ''), areas: parts.filter(c => c.kind !== 'house').map(c => c.name), address: md.text || '', precise: md.kind === 'house' && md.precision === 'exact', precision: md.precision || '' }));
    }
  } else if (p === 'geoapify') {
    const d = await getJson('https://api.geoapify.com/v1/geocode/search', { apiKey: key, text: sorgu, lang: 'tr', format: 'json', limit: 10, filter: 'rect:27.9,40.7,29.95,41.6' });
    for (const r of d.results) {
      const rank = r.rank || {};
      out.push(aday('Geoapify', r.lat, r.lon, { name: r.name || '', road: r.street || '', no: r.housenumber || '', areas: ['suburb', 'district', 'city', 'county', 'state'].map(k => r[k]), address: r.formatted || '', precise: !!r.housenumber && (rank.confidence_building_level || 0) >= .95 && rank.match_type === 'full_match', poi: r.result_type === 'amenity', dataset: r.datasource?.sourcename || 'Geoapify' }));
    }
  } else if (p === 'tomtom') {
    const d = await getJson('https://api.tomtom.com/search/2/search/' + encodeURIComponent(sorgu) + '.json', { key, language: 'tr-TR', countrySet: 'TR', limit: 10, lat: 41, lon: 29.05 });
    for (const r of d.results) {
      const a = r.address || {}, pos = r.position || {};
      out.push(aday('TomTom', pos.lat, pos.lon, { name: r.poi?.name || '', road: a.streetName || '', no: a.streetNumber || '', areas: ['municipalitySecondarySubdivision', 'municipalitySubdivision', 'municipality', 'countrySecondarySubdivision', 'countrySubdivision'].map(k => a[k]), address: a.freeformAddress || '', precise: r.type === 'Point Address', poi: r.type === 'POI' }));
    }
  } else if (p === 'maptiler') {
    const d = await getJson('https://api.maptiler.com/geocoding/' + encodeURIComponent(sorgu) + '.json', { key, language: 'tr', country: 'tr', limit: 10, bbox: '27.9,40.7,29.95,41.6', proximity: '29.05,41' });
    for (const f of d.features) {
      const [lon, lat] = f.center, pr = f.properties || {}, types = f.place_type || [];
      const adres = types.includes('address'), no = adres ? String(f.address || '') : '';
      out.push(aday('MapTiler', lat, lon, { name: f.text || '', road: adres ? f.text || '' : '', no, areas: (f.context || []).filter(c => !String(c.id || '').startsWith('postal_code')).map(c => c.text), address: f.place_name || '', precise: !!no && pr.kind !== 'virtual_street' && (f.relevance || 0) >= .9, poi: types.includes('poi'), dataset: 'MapTiler (OpenStreetMap)' }));
    }
  }
  return out.filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.lat >= 40.7 && c.lat <= 41.6 && c.lon >= 27.9 && c.lon <= 29.95);
}

export async function googleAra(sorgu, key) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.googleMapsUri,places.types' },
    body: JSON.stringify({ textQuery: sorgu, languageCode: 'tr', regionCode: 'TR', pageSize: 5, locationBias: { rectangle: { low: { latitude: 40.7, longitude: 27.9 }, high: { latitude: 41.6, longitude: 29.95 } } } }),
  });
  if (!r.ok) throw new ServisHatasi(r.status);
  return (await r.json()).places || [];
}

// ---------- TomTom trafik ----------
export const MAX_CELLS = 200; // ücretsiz planda senkron matris sınırı
export function bloklar(n, max = MAX_CELLS) {
  const hedef = Math.min(n, max), kaynak = Math.max(1, Math.floor(max / hedef)), out = [];
  for (let o = 0; o < n; o += kaynak) for (let d = 0; d < n; d += hedef) out.push([[o, Math.min(o + kaynak, n)], [d, Math.min(d + hedef, n)]]);
  return out;
}
const anahtarYap = (tur, pts) => tur + '|' + pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';');

// Çıkış saati: en az 10 dk, en fazla 24 saat sonrası; 15 dakikaya yukarı yuvarlanmış UTC. Geçmiş/yakın → null (canlı)
export function cikisSaati(metin, simdi = Date.now()) {
  if (!metin) return null;
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(String(metin))) throw new ServisHatasi(400, 'saat dilimi yok');
  const t = Date.parse(metin);
  if (!Number.isFinite(t)) throw new ServisHatasi(400, 'geçersiz saat');
  const fark = t - simdi;
  if (fark < 600000) return null;
  if (fark > 24 * 3600000) throw new ServisHatasi(400, 'çıkış saati çok ileri');
  const d = new Date(t); d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + (15 - d.getUTCMinutes() % 15) % 15);
  return d.toISOString().replace('.000Z', 'Z');
}

export async function matris(pts, key, { trafik = true, cikis = null } = {}) {
  const tur = trafik ? (cikis ? 'm@' + cikis : 'm') : 'm0';
  const hit = onbellekAl(anahtarYap(tur, pts));
  if (hit) return { ...hit, cached: true };
  const n = pts.length, dur = [], dist = [], delay = [];
  for (let i = 0; i < n; i++) { dur.push(Array(n).fill(0)); dist.push(Array(n).fill(0)); delay.push(Array(n).fill(0)); }
  const pt = p => ({ point: { latitude: p[0], longitude: p[1] } });
  const options = trafik && cikis ? { departAt: cikis, traffic: 'historical', travelMode: 'car', routeType: 'fastest' }
    : trafik ? { departAt: 'now', traffic: 'live', travelMode: 'car', routeType: 'fastest' }
    : { departAt: 'any', traffic: 'historical', travelMode: 'car', routeType: 'fastest' };
  for (const [[o0, o1], [d0, d1]] of bloklar(n)) {
    const data = await postJson('https://api.tomtom.com/routing/matrix/2?key=' + key, { origins: pts.slice(o0, o1).map(pt), destinations: pts.slice(d0, d1).map(pt), options });
    for (const c of data.data || []) {
      const i = o0 + c.originIndex, j = d0 + c.destinationIndex, s = c.routeSummary;
      if (!s) throw new ServisHatasi(502, `matris hücresi eksik: ${i}→${j}`);
      dur[i][j] = s.travelTimeInSeconds; dist[i][j] = s.lengthInMeters; delay[i][j] = s.trafficDelayInSeconds || 0;
    }
  }
  for (let i = 0; i < n; i++) dur[i][i] = dist[i][i] = delay[i][i] = 0;
  const sonuc = { dur, dist, delay, at: Date.now() / 1000 };
  onbellekKoy(anahtarYap(tur, pts), sonuc);
  return { ...sonuc, cached: false };
}

export async function rota(pts, key, cikis = null) {
  const tur = cikis ? 'r@' + cikis : 'r';
  const hit = onbellekAl(anahtarYap(tur, pts));
  if (hit) return hit;
  const locs = pts.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(':');
  const d = await getJson(`https://api.tomtom.com/routing/1/calculateRoute/${locs}/json`, { key, traffic: 'true', departAt: cikis || 'now', travelMode: 'car', routeType: 'fastest' }, 60000);
  const r = d.routes[0];
  const legs = r.legs.map(l => ({ d: l.summary.lengthInMeters, t: l.summary.travelTimeInSeconds, delay: l.summary.trafficDelayInSeconds || 0 }));
  const line = r.legs.flatMap(l => (l.points || []).map(p => [p.latitude, p.longitude]));
  if (legs.length !== pts.length - 1) throw new ServisHatasi(502, 'bacak sayısı tutmuyor');
  const adim = Math.max(1, Math.floor(line.length / 2000));
  const sonuc = { legs, line: line.filter((_, i) => i % adim === 0) };
  onbellekKoy(anahtarYap(tur, pts), sonuc);
  return sonuc;
}

// ---------- openrouteservice ve yedek zinciri ----------
export const ORS_MAX = 59;
export async function orsMatris(pts, key) {
  const hit = onbellekAl(anahtarYap('o', pts));
  if (hit) return hit;
  if (pts.length > ORS_MAX) throw new ServisHatasi(400, `openrouteservice en fazla ${ORS_MAX} nokta`);
  const d = await postJson('https://api.openrouteservice.org/v2/matrix/driving-car', { locations: pts.map(p => [p[1], p[0]]), metrics: ['distance', 'duration'], units: 'm' }, { Authorization: key });
  const n = pts.length, ok = m => Array.isArray(m) && m.length === n && m.every(r => Array.isArray(r) && r.length === n && r.every(Number.isFinite));
  if (!ok(d.durations) || !ok(d.distances)) throw new ServisHatasi(502, 'openrouteservice yanıtı eksik');
  const sonuc = { dur: d.durations, dist: d.distances, at: Date.now() / 1000 };
  onbellekKoy(anahtarYap('o', pts), sonuc);
  return sonuc;
}
const neden = e => ({ 401: 'anahtar reddedildi', 403: 'anahtar reddedildi', 429: 'kota doldu' })[e?.status] || (e?.status ? 'hata ' + e.status : e?.name || 'hata');
export async function yolMatrisi(pts, tomtomKey, orsKey) {
  const hatalar = [];
  if (tomtomKey) { try { return { ...(await matris(pts, tomtomKey, { trafik: false })), kaynak: 'TomTom' }; } catch (e) { hatalar.push('TomTom: ' + neden(e)); } }
  if (orsKey) { try { return { ...(await orsMatris(pts, orsKey)), kaynak: 'openrouteservice' }; } catch (e) { hatalar.push('openrouteservice: ' + neden(e)); } }
  const e = new Error(hatalar.join('; ') || 'yol servisi anahtarı yok'); e.yok = true; throw e;
}
