"""고정 IdP hosted login의 새 세션만 사용한다. MFA·추가 동의·예상 밖 화면은 unknown이다."""
import base64
import hashlib
import http.cookiejar
from html.parser import HTMLParser
import json
import secrets
import urllib.error
import urllib.parse
import urllib.request
from snapshot import Unknown, NoRedirect, origin, http as http_request


class LoginForm(HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms, self.current = [], None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'form':
            self.current = {'action': attrs.get('action', ''), 'method': attrs.get('method', '').lower(), 'fields': {}, 'names': set()}
        if tag == 'input' and self.current is not None and attrs.get('name'):
            self.current['names'].add(attrs['name'])
            if attrs.get('type', '').lower() == 'hidden':
                self.current['fields'][attrs['name']] = attrs.get('value', '')

    def handle_endtag(self, tag):
        if tag == 'form' and self.current is not None:
            self.forms.append(self.current)
            self.current = None


def login(enrollment, tenant, config, credential):
    """비밀은 메모리·요청에만 둔다. refresh token은 반환·저장하지 않는다."""
    enrollment, idp = origin(enrollment), origin(config['idpOrigin'])
    redirect = config['redirectUri']
    parsed = urllib.parse.urlsplit(redirect)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.query or parsed.fragment or not parsed.port:
        raise Unknown('oidc_loopback_contract_required')
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    state = secrets.token_urlsafe(32)
    url = enrollment + '/api/v1/auth/oidc/authorize?' + urllib.parse.urlencode({
        'tenant_id': tenant, 'redirect_uri': redirect, 'state': state, 'code_challenge': challenge,
        'code_challenge_method': 'S256', 'login_hint': credential['username']})
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    data, headers, submitted = None, {}, False
    for _ in range(16):
        parts = urllib.parse.urlsplit(url)
        current_origin = parts.scheme + '://' + parts.netloc
        if url.split('?', 1)[0] == redirect:
            query = urllib.parse.parse_qs(parts.query, strict_parsing=True)
            if query.get('state') != [state] or len(query.get('code', [])) != 1 or set(query) != {'code', 'state'} or not submitted:
                raise Unknown('oidc_callback_mismatch')
            token_body = json.dumps({'code': query['code'][0], 'redirect_uri': redirect, 'code_verifier': verifier}).encode()
            status, body, _ = http_request(enrollment + '/api/v1/auth/cli/token', token_body, {'Content-Type': 'application/json'})
            if status != 200:
                raise Unknown('oidc_token_exchange_unavailable')
            tokens = json.loads(body)
            if tokens.get('token_type') != 'Bearer' or not tokens.get('access_token'):
                raise Unknown('oidc_token_contract_mismatch')
            return tokens['access_token']
        if current_origin not in (enrollment, idp):
            raise Unknown('oidc_redirect_origin_rejected')
        try:
            with opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=15) as response:
                status, body, response_headers = response.status, response.read(1024 * 1024), dict(response.headers)
        except urllib.error.HTTPError as error:
            status, response_headers = error.code, dict(error.headers)
            error.close()
            body = b''
        except (OSError, urllib.error.URLError):
            raise Unknown('oidc_transport_unavailable') from None
        data, headers = None, {}
        if status in (301, 302, 303):
            url = urllib.parse.urljoin(url, response_headers.get('Location', ''))
            continue
        if status != 200 or current_origin != idp or submitted:
            raise Unknown('oidc_interactive_challenge_required')
        parser = LoginForm()
        parser.feed(body.decode())
        forms = [form for form in parser.forms if form['method'] == 'post' and {'username', 'password'} <= form['names']]
        if len(forms) != 1:
            raise Unknown('oidc_login_form_unrecognized')
        form = forms[0]
        action = urllib.parse.urljoin(url, form['action'])
        if origin(urllib.parse.urlsplit(action)._replace(path='', query='', fragment='').geturl()) != idp:
            raise Unknown('oidc_form_origin_rejected')
        fields = {**form['fields'], 'username': credential['username'], 'password': credential['password']}
        data, headers = urllib.parse.urlencode(fields).encode(), {'Content-Type': 'application/x-www-form-urlencoded'}
        url, submitted = action, True
    raise Unknown('oidc_redirect_limit')
