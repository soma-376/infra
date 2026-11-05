"""실제 AWS CLI의 DescribeSecret metadata-only 계약을 외부 연결 없이 확인한다."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
import threading
import unittest
from unittest.mock import patch
from snapshot import Sources


@unittest.skipUnless(shutil.which('aws') and os.environ.get('DELIVERY_VERIFIER_NETWORK_TESTS') == '1', '격리 컨테이너의 opt-in AWS metadata fixture')
class AwsMetadataTests(unittest.TestCase):
    def test_describe_secret_reads_version_metadata_and_never_value(self):
        arn = 'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:fixture-abcdef'
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                target = self.headers['X-Amz-Target']
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((target, data))
                assert target == 'secretsmanager.DescribeSecret' and data == {'SecretId': arn}
                body = json.dumps({'ARN': arn, 'Name': 'fixture', 'VersionIdsToStages': {'a' * 32: ['AWSCURRENT']}, 'Tags': [{'Key': 'extra', 'Value': 'excluded'}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-amz-json-1.1')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {'AWS_ENDPOINT_URL_SECRETS_MANAGER': 'http://127.0.0.1:' + str(server.server_port),
                                        'AWS_ACCESS_KEY_ID': 'fixture-only', 'AWS_SECRET_ACCESS_KEY': 'fixture-only', 'AWS_EC2_METADATA_DISABLED': 'true'}):
                result = Sources({}, {}).describe_secret(arn)
                self.assertEqual(result, {'ARN': arn, 'VersionIdsToStages': {'a' * 32: ['AWSCURRENT']}, 'DeletedDate': None})
                self.assertEqual(len(requests), 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
