"""실제 AWS CLI와 로컬 S3 protocol fixture로 exact ListObjectsV2만 사용하는지 검증한다."""
import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import shutil
import threading
import time
import unittest
import urllib.parse
from unittest.mock import patch
from verify import Verifier
from snapshot import Unknown


@unittest.skipUnless(shutil.which('aws') and os.environ.get('DELIVERY_VERIFIER_NETWORK_TESTS') == '1', '격리 컨테이너의 opt-in AWS CLI fixture')
class S3MetadataTests(unittest.TestCase):
    def test_exact_prefix_one_key_without_get_object(self):
        key = 'eks/claude_code/logs/year=2026/month=11/logs_fixture.json'
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                requests.append(query)
                assert query['list-type'] == ['2'] and query['max-keys'] == ['1'] and query['prefix'] == [key]
                assert self.headers['x-amz-expected-bucket-owner'] == '111111111111'
                stamp = dt.datetime.now(dt.timezone.utc).isoformat()
                body = ('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                        '<Name>fixture-archive</Name><Prefix>' + key + '</Prefix><KeyCount>1</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>true</IsTruncated><NextContinuationToken>fixture-next-page</NextContinuationToken>'
                        '<Contents><Key>' + key + '</Key><LastModified>' + stamp + '</LastModified><Size>42</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/xml')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {'AWS_ENDPOINT_URL_S3': 'http://127.0.0.1:' + str(server.server_port),
                                        'AWS_ACCESS_KEY_ID': 'fixture-only', 'AWS_SECRET_ACCESS_KEY': 'fixture-only',
                                        'AWS_DEFAULT_REGION': 'ap-northeast-2', 'AWS_EC2_METADATA_DISABLED': 'true'}):
                verifier = Verifier({}, {}, {'archive': {'bucket': 'fixture-archive', 'accountId': '111111111111'}}, {})
                verifier.archive('s3://fixture-archive/' + key, time.time() - 1)
                self.assertEqual(verifier.checks, ['archive_exact_key_metadata'])
                self.assertEqual(len(requests), 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
