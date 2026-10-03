import unittest
from unittest.mock import patch

import trafik


class TrafikTests(unittest.TestCase):
    def setUp(self):
        trafik._cache.clear()

    def test_road_matrix_yedek_zinciri(self):
        import io, json, urllib.error
        pts = [[41.0, 29.0], [41.01, 29.01], [41.02, 29.02]]
        ok_tomtom = lambda url, body: {"data": [{"originIndex": i, "destinationIndex": j, "routeSummary": {"travelTimeInSeconds": 60, "lengthInMeters": 500}} for i in range(3) for j in range(3)]}
        with patch.object(trafik, "_post", side_effect=ok_tomtom) as post:
            m = trafik.road_matrix(pts, "tt", "ors")
            self.assertEqual(m["kaynak"], "TomTom")
            self.assertEqual(post.call_args[0][1]["options"]["traffic"], "historical", "trafiksiz yedek")
        trafik._cache.clear()
        quota = urllib.error.HTTPError("u", 429, "kota", {}, io.BytesIO(b""))
        ors_body = json.dumps({"durations": [[0, 70, 80], [70, 0, 90], [80, 90, 0]], "distances": [[0, 600, 700], [600, 0, 800], [700, 800, 0]]}).encode()

        class Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): pass
        with patch.object(trafik, "_post", side_effect=quota), patch.object(trafik.urllib.request, "urlopen", return_value=Resp(ors_body)) as op:
            m = trafik.road_matrix(pts, "tt", "ors")
            self.assertEqual((m["kaynak"], m["dur"][0][1]), ("openrouteservice", 70))
            self.assertEqual(op.call_args[0][0].get_header("Authorization"), "ors")
        trafik._cache.clear()
        with patch.object(trafik, "_post", side_effect=quota):
            with self.assertRaises(LookupError) as e:
                trafik.road_matrix(pts, "tt", "")
            self.assertIn("kota doldu", str(e.exception))
        with self.assertRaises(LookupError):
            trafik.road_matrix(pts, "", "")

    def test_cikis_saati(self):
        import datetime
        now = datetime.datetime(2026, 10, 5, 6, 0, tzinfo=datetime.timezone.utc)
        self.assertIsNone(trafik.depart_at("2026-10-05T06:05:00Z", now), "yakın saat → canlı")
        self.assertIsNone(trafik.depart_at("2026-10-05T05:00:00Z", now), "geçmiş → canlı")
        self.assertEqual(trafik.depart_at("2026-10-05T07:31:00Z", now), "2026-10-05T07:45:00Z")
        self.assertEqual(trafik.depart_at("2026-10-05T10:31:00+03:00", now), "2026-10-05T07:45:00Z")
        with self.assertRaises(ValueError):
            trafik.depart_at("2026-10-07T07:00:00Z", now)
        with self.assertRaises(ValueError):
            trafik.depart_at("2026-10-05T07:00:00", now)
        calls = []
        fake = lambda url, body: calls.append(body) or {"data": [{"originIndex": i, "destinationIndex": j, "routeSummary": {"travelTimeInSeconds": 60, "lengthInMeters": 500}} for i in range(2) for j in range(2)]}
        with patch.object(trafik, "_post", side_effect=fake):
            trafik.matrix([[41, 29], [41.01, 29.01]], "k", depart="2026-10-05T07:45:00Z")
            self.assertEqual(calls[-1]["options"], {"departAt": "2026-10-05T07:45:00Z", "traffic": "historical", "travelMode": "car", "routeType": "fastest"})
            trafik.matrix([[41, 29], [41.01, 29.01]], "k")
            self.assertEqual(calls[-1]["options"]["traffic"], "live", "çıkış saati yoksa canlı; önbellek ayrı")

    def test_blocks_cover_matrix_within_free_limit(self):
        for n in (2, 8, 30, 70, 150):
            cells = set()
            for (o0, o1), (d0, d1) in trafik.blocks(n):
                self.assertLessEqual((o1 - o0) * (d1 - d0), trafik.MAX_CELLS)
                cells |= {(i, j) for i in range(o0, o1) for j in range(d0, d1)}
            self.assertEqual(len(cells), n * n, "her hücre tam bir kez")
        self.assertEqual(len(trafik.blocks(30)), 5)

    def test_matrix_assembles_blocks_and_caches(self):
        calls = []

        def fake(url, body):
            calls.append(body)
            o, d = len(body["origins"]), len(body["destinations"])
            return {"data": [{"originIndex": i, "destinationIndex": j, "routeSummary": {
                "travelTimeInSeconds": 100 + i + j, "lengthInMeters": 1000, "trafficDelayInSeconds": 7}} for i in range(o) for j in range(d)]}

        pts = [[41 + i / 100, 29] for i in range(30)]
        with patch.object(trafik, "_post", side_effect=fake):
            m = trafik.matrix(pts, "k")
            self.assertEqual(len(calls), 5)
            self.assertEqual(calls[0]["options"]["traffic"], "live")
            self.assertEqual(m["dur"][0][0], 0)
            self.assertEqual(m["dur"][7][3], 100 + 1 + 3, "ikinci bloğun (6-11) içindeki 1. satır")
            self.assertEqual(m["delay"][7][3], 7)
            m2 = trafik.matrix(pts, "k")
        self.assertTrue(m2["cached"])
        self.assertEqual(len(calls), 5, "önbellekten: yeni istek yok")

    def test_matrix_missing_cell_raises(self):
        with patch.object(trafik, "_post", return_value={"data": [{"originIndex": 0, "destinationIndex": 1}]}):
            with self.assertRaises(ValueError):
                trafik.matrix([[41, 29], [41.1, 29.1]], "k")

    def test_route_legs(self):
        reply = {"routes": [{"legs": [
            {"summary": {"lengthInMeters": 5000, "travelTimeInSeconds": 900, "trafficDelayInSeconds": 120}, "points": [{"latitude": 41, "longitude": 29}]},
            {"summary": {"lengthInMeters": 3000, "travelTimeInSeconds": 400}, "points": [{"latitude": 41.1, "longitude": 29.1}]}]}]}
        with patch.object(trafik, "_get", return_value=reply) as call:
            r = trafik.route([[41, 29], [41.05, 29.05], [41.1, 29.1]], "k")
        self.assertIn("traffic=true", call.call_args.args[0])
        self.assertEqual(r["legs"][0], {"d": 5000, "t": 900, "delay": 120})
        self.assertEqual(r["legs"][1]["delay"], 0)
        self.assertEqual(len(r["line"]), 2)


if __name__ == "__main__":
    unittest.main()
