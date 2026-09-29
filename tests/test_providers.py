import unittest
from unittest.mock import patch
import providers as p


class ProviderTests(unittest.TestCase):
    def search(self, provider, data, mode='address'):
        with patch.object(p, 'get_json', return_value=data) as call:
            result = p.provider_search(provider, 'Örnek Sokak 12A İstanbul', 'secret', mode)
            self.assertNotIn('secret', str(result))
            return result, call.call_args

    def test_yandex_precision(self):
        for precision in ('exact', 'near', 'number', 'range', 'street'):
            data = {'response': {'GeoObjectCollection': {'featureMember': [{'GeoObject': {
                'Point': {'pos': '29 41'}, 'metaDataProperty': {'GeocoderMetaData': {
                    'kind':'house', 'precision':precision, 'Address': {'Components': [
                        {'kind':'street','name':'Örnek Sokak'}, {'kind':'house','name':'12A'},
                        {'kind':'district','name':'Kadıköy'}]}}}}}]}}}
            result, call = self.search('yandex', data)
            self.assertEqual(result[0]['precision'], precision)
            self.assertEqual(result[0]['lat'], 41)
            self.assertEqual(call.args[1]['rspn'], 1)

    def test_geoapify_confidence_and_shared_dataset(self):
        for confidence in (.5, 1):
            data = {'results':[{'lat':41,'lon':29,'housenumber':'12A',
                'rank':{'confidence_building_level':confidence,'match_type':'full_match'},
                'datasource':{'sourcename':'openstreetmap'}}]}
            result, _ = self.search('geoapify', data)
            self.assertEqual(result[0]['dataset'],'openstreetmap')
            self.assertEqual(result[0]['precision'],'exact' if confidence == 1 else 'approximate')

    def test_tomtom_points_and_bounds(self):
        for kind in ('Point Address','Address Range'):
            result, _ = self.search('tomtom', {'results':[{'type':kind,'position':{'lat':41,'lon':29},
                'address':{'streetNumber':'12A','streetName':'Örnek Sokak'}}]})
            self.assertEqual(result[0]['precision'],'exact' if kind == 'Point Address' else 'approximate')
        result, _ = self.search('tomtom', {'results':[{'type':'Point Address','position':{'lat':41,'lon':29},
            'address':{'streetNumber':'16','streetName':'Cavitpaşa Sokak','municipalitySecondarySubdivision':'Göztepe','municipality':'İstanbul'}}]})
        self.assertIn('Göztepe', result[0]['areas'], 'TomTom mahallesi kaybolmamalı')
        for lat in (None, float('nan'), 0, 90):
            self.assertEqual(self.search('tomtom', {'results':[{'position':{'lat':lat,'lon':29}}]})[0], [])


    def test_maptiler_virtual_street_is_approximate(self):
        for kind in ('virtual_street', None):
            props = {'kind': kind} if kind else {}
            result, _ = self.search('maptiler', {'features':[{'center':[29,41],'place_type':['address'],'text':'Örnek Sokak',
                'address':'12A','relevance':1,'properties':props,'context':[{'id':'municipal_district.1','text':'Göztepe Mahallesi'}]}]})
            self.assertEqual(result[0]['precision'],'approximate' if kind else 'exact')
            self.assertIn('Göztepe Mahallesi', result[0]['areas'])


if __name__ == '__main__':
    unittest.main()
