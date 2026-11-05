"""실제 HTTPS·cookie·redirect를 쓰는 합성 IdP. 외부 IdP나 실제 사용자 자격은 사용하지 않는다."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.parse
from unittest.mock import patch
from oidc import login
from snapshot import Unknown


@unittest.skipUnless(shutil.which('openssl') and os.environ.get('DELIVERY_VERIFIER_NETWORK_TESTS') == '1', '격리 컨테이너의 opt-in HTTPS fixture')
class OidcFlowTests(unittest.TestCase):
    def test_fresh_pkce_cookie_login_and_interactive_challenge_fail_closed(self):
        state = {'logins': 0, 'exchanges': 0, 'challenges': [], 'mfa': False}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def reply(self, status, body=b'', headers=None):
                self.send_response(status)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)
            def do_GET(self):
                path = urllib.parse.urlsplit(self.path)
                if path.path.endswith('/authorize'):
                    query = urllib.parse.parse_qs(path.query)
                    state['request'] = query
                    state['challenges'].append(query['code_challenge'][0])
                    self.reply(302, headers={'Location': '/login', 'Set-Cookie': 'fixture_session=only-test; Path=/; Secure; HttpOnly'})
                elif path.path == '/login':
                    self.reply(200, b'<form method="post" action="/login"><input type="hidden" name="_csrf" value="fixture-csrf"><input name="username"><input name="password" type="password"></form>')
                elif path.path == '/api/v1/auth/oidc/callback/fixture':
                    request = state['request']
                    self.reply(302, headers={'Location': request['redirect_uri'][0] + '?' + urllib.parse.urlencode({'code': 'fixture-one-time-code', 'state': request['state'][0]})})
                else:
                    self.reply(404)
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                if self.path == '/login':
                    data = urllib.parse.parse_qs(body.decode())
                    assert data == {'_csrf': ['fixture-csrf'], 'username': ['synthetic-user'], 'password': ['fixture-only']}
                    assert self.headers['Cookie'] == 'fixture_session=only-test'
                    state['logins'] += 1
                    self.reply(200, b'<form>Enter MFA code</form>') if state['mfa'] else self.reply(302, headers={'Location': '/api/v1/auth/oidc/callback/fixture'})
                elif self.path == '/api/v1/auth/cli/token':
                    data = json.loads(body)
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(data['code_verifier'].encode()).digest()).rstrip(b'=').decode()
                    assert challenge == state['request']['code_challenge'][0]
                    assert set(data) == {'code', 'redirect_uri', 'code_verifier'}
                    state['exchanges'] += 1
                    self.reply(200, b'{"token_type":"Bearer","access_token":"fixture-access","refresh_token":"fixture-unused"}')
                else:
                    self.reply(404)
        with tempfile.TemporaryDirectory() as directory:
            cert, key = Path(directory) / 'cert.pem', Path(directory) / 'key.pem'
            subprocess.run(['openssl', 'req', '-new', '-x509', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                endpoint = 'https://localhost:' + str(server.server_port)
                with patch.dict(os.environ, {'SSL_CERT_FILE': str(cert)}):
                    config = {'idpOrigin': endpoint, 'redirectUri': 'http://127.0.0.1:49152/callback'}
                    credential = {'username': 'synthetic-user', 'password': 'fixture-only'}
                    for _ in range(2):
                        self.assertEqual(login(endpoint, 'fixture-tenant', config, credential), 'fixture-access')
                    self.assertEqual(state['logins'], 2)
                    self.assertEqual(state['exchanges'], 2)
                    self.assertEqual(len(set(state['challenges'])), 2)
                    state['mfa'] = True
                    with self.assertRaisesRegex(Unknown, 'interactive_challenge'):
                        login(endpoint, 'fixture-tenant', config, credential)
                    self.assertEqual(state['exchanges'], 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
