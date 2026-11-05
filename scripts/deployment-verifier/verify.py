#!/usr/bin/env python3
"""PostSync 검증. 후보 실행·self Application 대기·비밀/원문 로그 없이 증거만 반환한다."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.parse
import uuid
from fixture import payload, expected_observation_id
from oidc import login
from snapshot import APPS, Unknown, Failed, Sources, canonical, digest, fingerprints, histories, http, origin, validate_migrations

HEX = re.compile(r'^[0-9a-f]{64}$')
ARCHIVE = re.compile(r'^eks/claude_code/logs/[A-Za-z0-9_./=-]+\.json$')


def validate_inputs(binding, contract_bytes, config):
    if binding.get('schemaVersion') != 1 or binding.get('stage') not in APPS:
        raise Unknown('binding_invalid')
    for field in ('bundleManifestSha256', 'contractSha256'):
        if not HEX.fullmatch(binding.get(field, '')):
            raise Unknown('binding_hash_invalid')
    if not re.fullmatch(r'[0-9a-f]{40}', binding.get('infraCommit', '')) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{15,62}', binding.get('operationNonce', '')):
        raise Unknown('binding_revision_invalid')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', binding.get('imageDigest', '')):
        raise Unknown('binding_image_invalid')
    if hashlib.sha256(contract_bytes).hexdigest() != binding['contractSha256']:
        raise Unknown('contract_hash_mismatch')
    contract = json.loads(contract_bytes)
    if contract.get('schemaVersion') != 1 or contract.get('app') != binding['stage']:
        raise Unknown('contract_app_mismatch')
    # 생산기의 계약 인코딩은 sorted compact JSON + LF다. 실행 증거 인코딩과 혼동하지 않는다.
    if hashlib.sha256(canonical(contract['compatibility']) + b'\n').hexdigest() != contract['compatibilitySha256']:
        raise Unknown('compatibility_hash_mismatch')
    if config.get('schemaVersion') != 1:
        raise Unknown('config_version_invalid')
    return contract


def validate_vector(values, timestamps, *, partitions, fresh_after, expected_instance=None):
    """timestamp()의 실제 scrape 시각을 대조한다. 누락/중복/다중 exporter를 0으로 만들지 않는다."""
    if len(values) != partitions or len(timestamps) != partitions:
        raise Unknown('kafka_partition_set_incomplete')
    def index(rows):
        result = {}
        for row in rows:
            labels = row['metric']
            partition = int(labels['partition'])
            identity = (labels.get('job'), labels.get('instance'), labels.get('topic'), labels.get('consumergroup'), partition)
            if identity in result:
                raise Unknown('kafka_duplicate_series')
            result[identity] = float(row['value'][1])
        return result
    values, timestamps = index(values), index(timestamps)
    if set(values) != set(timestamps) or {key[4] for key in values} != set(range(partitions)):
        raise Unknown('kafka_partition_identity_mismatch')
    instances = {key[1] for key in values}
    if len(instances) != 1 or None in instances or (expected_instance is not None and instances != {expected_instance}):
        raise Unknown('kafka_exporter_changed')
    if any(not math.isfinite(value) or value <= fresh_after or value > time.time() + 5 for value in timestamps.values()):
        raise Unknown('kafka_scrape_not_fresh')
    if any(not value.is_integer() or value < 0 for value in values.values()):
        raise Unknown('kafka_offset_invalid')
    return {key[4]: int(value) for key, value in values.items()}, next(iter(instances))


def validate_exporter(values, timestamps, fresh_after, instance=None, expect_up=False):
    if len(values) != 1 or len(timestamps) != 1 or values[0]['metric'].get('instance') != timestamps[0]['metric'].get('instance'):
        raise Unknown('exporter_identity_ambiguous')
    found = values[0]['metric'].get('instance')
    if not found or (instance is not None and found != instance):
        raise Unknown('kafka_exporter_changed')
    stamp = float(timestamps[0]['value'][1])
    value = float(values[0]['value'][1])
    if not math.isfinite(stamp) or stamp <= fresh_after or stamp > time.time() + 5:
        raise Unknown('kafka_scrape_not_fresh')
    if not value.is_integer() or (expect_up and value != 1) or (not expect_up and not 1 <= value <= 10000):
        raise Unknown('exporter_up_or_partition_count_invalid')
    return int(value), found


class Verifier:
    def __init__(self, binding, contract, config, probe, sources=None):
        self.binding, self.contract, self.config, self.probe = binding, contract, config, probe
        self.sources = sources or Sources(config, probe)
        self.checks = []

    def checked(self, code):
        self.checks.append(code)

    def request_json(self, url, data=None, token=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        status, body, _ = http(url, canonical(data) if data is not None else None, headers)
        if status != 200:
            # 인증·quota·외부 의존 장애는 후보 이미지의 확정 실패가 아니다.
            raise Unknown('functional_http_' + str(status))
        return json.loads(body)

    def readiness(self):
        stage = self.binding['stage']
        dep = self.sources.kube('/apis/apps/v1/namespaces/pulsemetry-dev/deployments/' + stage)
        status = dep.get('status', {})
        count = dep['spec'].get('replicas', 1)
        containers = dep['spec']['template']['spec']['containers']
        if count < 1 or status.get('observedGeneration', 0) < dep['metadata']['generation'] or status.get('availableReplicas', 0) != count or status.get('updatedReplicas', 0) != count:
            raise Unknown('workload_not_ready')
        if not any(c['image'].endswith('@' + self.binding['imageDigest']) for c in containers):
            raise Unknown('workload_digest_mismatch')
        self.checked('workload_ready')

    def token(self):
        result = self.request_json(origin(self.config['enrollmentOrigin']) + '/api/v1/installations/telemetry-token', {}, self.probe['installationToken'])
        if str(result.get('installation_id')) != self.probe['installationId'] or not result.get('telemetry_token'):
            raise Failed('telemetry_token_contract_mismatch')
        self.checked('pit_telemetry_token')
        return result['telemetry_token']

    def enrollment(self):
        self.token()
        # 성공 스크립트와 같은 200을 반환하는 오류 스크립트를 구분하며 실행하지 않는다.
        code = self.probe['invitationCode']
        if not re.fullmatch(r'[A-Za-z0-9_-]{32}', code):
            raise Unknown('bootstrap_fixture_invalid')
        for path in ('unix', 'windows'):
            status, body, headers = http(origin(self.config['enrollmentOrigin']) + '/' + path + '?' + urllib.parse.urlencode({'code': code}))
            if status != 200 or headers.get('Cache-Control', '').lower() != 'no-store':
                raise Unknown('bootstrap_read_unavailable')
            if code.encode() not in body or b'/api/v1/enroll' not in body or b'__PULSEMETRY_' in body:
                raise Unknown('bootstrap_fixture_or_assets_invalid')
        self.checked('bootstrap_assets')

    def telemetry_rows(self, session, request):
        # 이 고정 tenant 제한 view만 조회한다. 원천 테이블·원문 payload 권한은 주지 않는다.
        return self.sources.ch("SELECT observation_id,tenant_id,installation_id,session_id,request_id,event_type,tokens_input,tokens_output,archive_ref "
                               "FROM deployment_verification.telemetry_events "
                               "WHERE tenant_id={tenant:String} AND installation_id={installation:String} "
                               "AND session_id={session:String} AND request_id={request:String} FORMAT JSONEachRow",
                               {'param_tenant': self.probe['tenantId'], 'param_installation': self.probe['installationId'],
                                'param_session': session, 'param_request': request})

    def prometheus(self, expression):
        cfg = self.config['prometheus']
        path = '/api/v1/namespaces/' + cfg['namespace'] + '/services/' + cfg['proxyName'] + '/proxy/api/v1/query?'
        response = self.sources.kube(path + urllib.parse.urlencode({'query': expression}))
        if response.get('status') != 'success' or response['data'].get('resultType') != 'vector':
            raise Unknown('prometheus_read_unavailable')
        return response['data']['result']

    def offsets(self, committed, fresh_after, instance=None):
        cfg = self.config['prometheus']
        def samples(metric):
            rows = self.prometheus('label_replace(' + metric + ',"verification_sample","value","job",".*") or '
                                   'label_replace(timestamp(' + metric + '),"verification_sample","timestamp","job",".*")')
            return ([row for row in rows if row['metric'].get('verification_sample') == 'value'],
                    [row for row in rows if row['metric'].get('verification_sample') == 'timestamp'])
        count_selector = '{topic=' + json.dumps(cfg['topic']) + ',job=' + json.dumps(cfg['exporterJob']) + '}'
        partitions, exporter = validate_exporter(*samples('kafka_topic_partitions' + count_selector), fresh_after, instance)
        validate_exporter(*samples('up{job=' + json.dumps(cfg['exporterJob']) + ',instance=' + json.dumps(exporter) + '}'), fresh_after, exporter, expect_up=True)
        labels = {'topic': cfg['topic'], 'job': cfg['exporterJob']}
        if committed:
            labels['consumergroup'] = cfg['consumerGroup']
        selector = '{' + ','.join(key + '=' + json.dumps(value) for key, value in labels.items()) + '}'
        metric = ('kafka_consumergroup_current_offset' if committed else 'kafka_topic_partition_current_offset') + selector
        # 같은 PromQL 평가에서 값과 실제 sample timestamp를 얻어 두 GET 사이 scrape race를 막는다.
        return validate_vector(*samples(metric), partitions=partitions, fresh_after=fresh_after, expected_instance=exporter)

    def archive(self, reference, after):
        parsed = urllib.parse.urlsplit(reference)
        key = urllib.parse.unquote(parsed.path.lstrip('/'))
        if parsed.scheme != 's3' or parsed.netloc != self.config['archive']['bucket'] or parsed.query or parsed.fragment or not ARCHIVE.fullmatch(key) or '..' in key:
            raise Failed('archive_reference_invalid')
        result = subprocess.run(['aws', 's3api', 'list-objects-v2', '--bucket', parsed.netloc, '--prefix', key,
                                 '--max-keys', '1', '--expected-bucket-owner', self.config['archive']['accountId'], '--output', 'json', '--no-cli-pager', '--no-paginate'],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=False)
        if result.returncode:
            raise Unknown('archive_metadata_unavailable')
        objects = json.loads(result.stdout).get('Contents', [])
        if len(objects) != 1 or objects[0].get('Key') != key or objects[0].get('Size', 0) <= 0:
            raise Unknown('archive_metadata_missing')
        modified = dt.datetime.fromisoformat(objects[0]['LastModified'].replace('Z', '+00:00')).timestamp()
        if modified < int(after):
            raise Failed('archive_object_predates_probe')
        self.checked('archive_exact_key_metadata')

    def gateway(self):
        token = self.token()
        session = str(uuid.uuid4())
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        body, request = payload(session, now)
        if self.telemetry_rows(session, request):
            raise Unknown('probe_identity_already_present')
        # ACK 불명 시 재전송하지 않는다. 한 번만 보낸다.
        sent = time.time()
        status, _, _ = http(origin(self.config['gatewayOrigin']) + '/v1/logs', body,
                             {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        token = None
        if status != 200:
            raise Unknown('gateway_ack_unavailable')
        ack = time.time()
        self.checked('gateway_ack')
        # exporter가 이전 수집 결과를 돌려주는 창을 닫고 fresh vector를 한 번 고정한다.
        settle = self.config['prometheus']['collectionMaxSeconds'] + self.config['prometheus']['scrapeIntervalSeconds']
        if not 0 < settle <= 90:
            raise Unknown('exporter_freshness_config_invalid')
        deadline, end, instance, committed = time.monotonic() + 240, None, None, False
        expected = expected_observation_id(body, self.probe['tenantId'], self.probe['installationId'])
        exact = None
        while time.monotonic() < deadline:
            rows = self.telemetry_rows(session, request)
            if rows:
                if len(rows) != 1:
                    raise Failed('telemetry_duplicate_logical_rows')
                row = rows[0]
                if (row.get('observation_id') != expected or row.get('event_type') != 'model.response.usage' or
                    int(row.get('tokens_input', 0)) != 1066 or int(row.get('tokens_output', 0)) != 28 or
                    row.get('tenant_id') != self.probe['tenantId'] or row.get('installation_id') != self.probe['installationId'] or
                    row.get('session_id') != session or row.get('request_id') != request):
                    raise Failed('telemetry_exact_row_mismatch')
                exact = row
            try:
                if end is None:
                    end, instance = self.offsets(False, ack + settle)
                else:
                    current, _ = self.offsets(True, ack + settle, instance)
                    if set(current) != set(end):
                        raise Unknown('kafka_partition_set_changed')
                    committed = all(current[part] >= offset for part, offset in end.items())
            except Unknown as error:
                if str(error) != 'kafka_scrape_not_fresh':
                    raise
            if exact is not None and committed:
                self.archive(exact['archive_ref'], sent)
                self.checked('clickhouse_exact_logical_row')
                self.checked('kafka_fresh_committed_vector')
                return
            time.sleep(3)
        raise Unknown('pipeline_evidence_timeout')

    def ingest(self):
        # 조회 경로·전용 계정 준비도 확인한다. 다음 Gateway 단계가 실제 신규 적재를 입증한다.
        if self.sources.ch('SELECT 1 AS ready FORMAT JSONEachRow') != [{'ready': 1}]:
            raise Unknown('ingest_storage_unavailable')
        self.telemetry_rows(str(uuid.uuid4()), 'probe_preflight')
        self.checked('ingest_storage_readable')

    def dashboard(self):
        token = login(self.config['enrollmentOrigin'], self.probe['tenantId'], self.config['oidc'], self.probe['oidc'])
        self.checked('fresh_oidc_login')
        url = origin(self.config['dashboardOrigin']) + '/api/v1/organizations/' + str(uuid.UUID(self.probe['tenantId']))
        today = dt.datetime.now(dt.timezone.utc).date().isoformat()
        result = self.request_json(url + '/analytics/overview?' + urllib.parse.urlencode({'startDate': today, 'endDate': today, 'compare': 'none'}), token=token)
        if result.get('errors') or not isinstance(result.get('summary'), dict) or any(key not in result['summary'] for key in ('totalTokens', 'sessionCount', 'activeUsers')):
            raise Failed('dashboard_read_contract_mismatch')
        self.checked('dashboard_authenticated_read')

    def run(self):
        self.readiness()
        stage = self.binding['stage']
        schemas = ['enrollment', 'telemetry_ops'] + (['dashboard_cache'] if stage == 'dashboard-api' else [])
        validate_migrations(histories(self.sources), self.contract['compatibility']['postgres'], schemas)
        self.checked('flyway_history_checksums')
        {'enrollment-api': self.enrollment, 'telemetry-ingest': self.ingest,
         'telemetry-gateway': self.gateway, 'dashboard-api': self.dashboard}[stage]()
        result = fingerprints(self.sources, self.contract)
        self.checked('actual_schema_runtime_key_tls')
        return result


def receipt(binding, result, checks, evidence, reason):
    value = {**binding, 'result': result, 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
             'checks': checks, 'reason': reason, 'evidence': evidence, 'evidenceSha256': digest(evidence)}
    raw = canonical(value)
    if len(raw) >= 4096:
        raise Unknown('receipt_too_large')
    return raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', required=True, type=Path)
    parser.add_argument('--probe-file', type=Path)
    parser.add_argument('--schema-only', action='store_true')
    parser.add_argument('--termination-file', type=Path, default=Path('/dev/termination-log'))
    args = parser.parse_args()
    binding, evidence, checks, result, reason = {}, {}, [], 'unknown', 'inputs_unavailable'
    if args.schema_only:
        try:
            from snapshot import schema_fingerprint
            config = json.loads((args.input_dir / 'config.json').read_text())
            probe = json.loads(args.probe_file.read_text() if args.probe_file else os.environ['DELIVERY_PROBE_CREDENTIAL_JSON'])
            print(json.dumps({'schemaFingerprint': schema_fingerprint(Sources(config, probe))}, separators=(',', ':')))
            return 0
        except Exception:
            print('{"result":"unknown","reason":"snapshot_unavailable"}')
            return 2
    try:
        binding = json.loads((args.input_dir / 'binding.json').read_text())
        config = json.loads((args.input_dir / 'config.json').read_text())
        contract = validate_inputs(binding, (args.input_dir / 'contract.json').read_bytes(), config)
        verifier = Verifier(binding, contract, config, json.loads(args.probe_file.read_text() if args.probe_file else os.environ['DELIVERY_PROBE_CREDENTIAL_JSON']))
        checks = verifier.checks
        evidence = verifier.run()
        result, reason = 'passed', 'all_checks_passed'
    except Failed as error:
        result, reason = 'failed', str(error)
    except Unknown as error:
        reason = str(error)
    except Exception:
        reason = 'verification_unavailable'
    # 외부 오류 메시지나 원문 body는 출력하지 않는다. binding도 고정 필드만 복사한다.
    allowed = {'schemaVersion', 'operationNonce', 'stage', 'infraCommit', 'bundleManifestSha256', 'imageDigest', 'contractSha256'}
    binding = {key: value for key, value in binding.items() if key in allowed and isinstance(value, (str, int)) and len(str(value)) <= 128}
    raw = receipt(binding, result, checks, evidence, reason)
    args.termination_file.write_bytes(raw)
    print(raw.decode())
    return {'passed': 0, 'failed': 1, 'unknown': 2}[result]


if __name__ == '__main__':
    raise SystemExit(main())
