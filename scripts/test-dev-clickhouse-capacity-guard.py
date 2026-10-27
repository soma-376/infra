#!/usr/bin/env python3
"""TTL/engine drift가 운영 전제 검사를 통과하지 못하는지 서버 없이 검사한다."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('dev-clickhouse-capacity-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
ENGINE = 'ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (event_date, event_time) SETTINGS index_granularity = 8192'
XML = '<clickhouse><metric_log><partition_by>toYYYYMM(event_date)</partition_by></metric_log></clickhouse>'


class GuardTests(unittest.TestCase):
    def test_original(self):
        guard.assert_original_metric_log('ATTACH TABLE metric_log (...) ' + ENGINE, XML)
        guard.assert_original_metric_log(ENGINE, '<clickhouse><metric_log/></clickhouse>')

    def test_engine_drift(self):
        for changed in [ENGINE + ' TTL event_date + INTERVAL 1 DAY', ENGINE + ', max_compress_block_size = 0',
                        ENGINE.replace('MergeTree', 'ReplacingMergeTree'), ENGINE.replace('toYYYYMM', 'toYYYYMMDD'),
                        ENGINE.replace('(event_date, event_time)', '(event_time)'), ENGINE.replace('8192', '4096')]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                guard.assert_original_metric_log(changed, XML)

    def test_server_xml_drift(self):
        for extra in ['<ttl>event_date + INTERVAL 1 DAY</ttl>', '<engine>' + ENGINE + '</engine>']:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                guard.assert_original_metric_log(ENGINE, XML.replace('</metric_log>', extra + '</metric_log>'))
        with self.assertRaises(ValueError):
            guard.assert_original_metric_log(ENGINE, XML.replace('toYYYYMM', 'toYYYYMMDD'))


if __name__ == '__main__':
    unittest.main()
