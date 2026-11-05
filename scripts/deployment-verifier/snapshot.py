"""읽기 전용 실제 DB·배포·키 metadata 지문. CLI와 PostSync Job이 같은 코드를 쓴다."""
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from strict_yaml import parse as parse_yaml

APPS = ('enrollment-api', 'telemetry-ingest', 'telemetry-gateway', 'dashboard-api')
SCHEMAS = ('enrollment', 'telemetry_ops', 'dashboard_cache')
SPCS = ('enrollment-api-runtime', 'telemetry-ingest-runtime', 'dashboard-api-runtime', 'enrollment-api-jwt', 'dashboard-api-jwt',
        'enrollment-api-telemetry-jwt', 'telemetry-ingest-telemetry-jwt', 'telemetry-gateway-telemetry-jwt')
TLS_SECRETS = ('soma-376-dev-telemetry-cluster-ca-cert', 'pulsemetry-gateway-main', 'pulsemetry-ingest-main',
               'pulsemetry-topic-admin-main', 'pulsemetry-offset-admin-main')


class Unknown(Exception):
    """관측·fixture 오류는 이미지 확정 실패로 분류하지 않는다."""


class Failed(Exception):
    """완전한 응답으로 입증한 계약/기능 불일치만 사용한다."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http(url, data=None, headers=None, context=None, method=None):
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))
    try:
        with opener.open(urllib.request.Request(url, data=data, headers=headers or {}, method=method), timeout=15) as response:
            body = response.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024:
                raise Unknown('response_too_large')
            return response.status, body, dict(response.headers)
    except urllib.error.HTTPError as error:
        status, headers = error.code, dict(error.headers)
        error.close()  # 오류 본문에는 SQL·자격·원문이 있을 수 있다.
        return status, b'', headers
    except (OSError, urllib.error.URLError, TimeoutError):
        raise Unknown('transport_unavailable') from None


def origin(value, private=False):
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise Unknown('invalid_origin')
    if not parsed.hostname or (parsed.scheme != 'https' and not (private and parsed.scheme == 'http')):
        raise Unknown('invalid_origin')
    return value.rstrip('/')


class Sources:
    def __init__(self, config, probe):
        self.config, self.probe = config, probe

    def kube(self, path, metadata=False):
        # 외부 runner는 SSM TLS hostname·CA 검증을 보존한 server/token 파일을 지정한다.
        proxy = os.environ.get('VERIFIER_KUBERNETES_PROXY_URL')
        if proxy:
            parsed = urllib.parse.urlsplit(proxy)
            if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
                raise Unknown('kubernetes_proxy_must_be_loopback')
            server, headers, context = proxy.rstrip('/'), {}, None
        else:
            server = os.environ.get('VERIFIER_KUBERNETES_SERVER', 'https://kubernetes.default.svc')
            ca = os.environ.get('VERIFIER_KUBERNETES_CA_FILE', '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt')
            token = Path(os.environ.get('VERIFIER_KUBERNETES_TOKEN_FILE', '/var/run/secrets/kubernetes.io/serviceaccount/token')).read_text().strip()
            headers, context = {'Authorization': 'Bearer ' + token}, ssl.create_default_context(cafile=ca)
            server = origin(server)
        if metadata:
            headers['Accept'] = 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1'
        status, body, _ = http(server + path, headers=headers, context=context)
        if status != 200:
            raise Unknown('kubernetes_read_unavailable')
        result = json.loads(body)
        if metadata and (result.get('kind') != 'PartialObjectMetadata' or set(result) - {'kind', 'apiVersion', 'metadata'}):
            raise Unknown('metadata_only_response_required')
        return result

    def pg(self, sql):
        cfg, credential = self.config['postgres'], self.probe['postgres']
        if cfg.get('sslmode') not in ('require', 'verify-full'):
            raise Unknown('postgres_tls_required')
        env = {**os.environ, 'PGHOST': cfg['host'], 'PGPORT': str(cfg.get('port', 5432)),
               'PGDATABASE': cfg['database'], 'PGUSER': credential['username'], 'PGPASSWORD': credential['password'],
               'PGSSLMODE': cfg['sslmode'], 'PGCONNECT_TIMEOUT': '10',
               'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=10000 -c search_path=pg_catalog'}
        if cfg.get('hostaddr'):
            env['PGHOSTADDR'] = cfg['hostaddr']
        if cfg.get('sslrootcert'):
            env['PGSSLROOTCERT'] = cfg['sslrootcert']
        result = subprocess.run(['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=False)
        if result.returncode:
            raise Unknown('postgres_read_unavailable')
        return json.loads(result.stdout)

    def ch(self, query, parameters=None):
        cfg, credential = self.config['clickhouse'], self.probe['clickhouse']
        # readonly=1은 요청별 setting 변경도 막는다. 서버 profile을 확인하고 query parameter만 보낸다.
        if not getattr(self, '_ch_profile_checked', False):
            self._ch_profile_checked = True
            profile = self.ch("SELECT getSetting('readonly') AS readonly,getSetting('max_execution_time') AS max_execution_time,"
                              "getSetting('max_result_rows') AS max_result_rows,getSetting('result_overflow_mode') AS result_overflow_mode FORMAT JSONEachRow")
            if len(profile) != 1 or int(profile[0]['readonly']) != 1 or not 0 < float(profile[0]['max_execution_time']) <= 10 or not 0 < int(profile[0]['max_result_rows']) <= 20000 or profile[0]['result_overflow_mode'] != 'throw':
                raise Unknown('clickhouse_readonly_profile_required')
        params = {'database': cfg['database'], **(parameters or {})}
        status, body, _ = http(origin(cfg['origin'], private=True) + '/?' + urllib.parse.urlencode(params), query.encode(),
                               {'X-ClickHouse-User': credential['username'], 'X-ClickHouse-Key': credential['password'], 'Content-Type': 'text/plain'})
        if status != 200:
            raise Unknown('clickhouse_read_unavailable')
        return [json.loads(line) for line in body.splitlines() if line]

    def describe_secret(self, arn):
        result = subprocess.run(['aws', 'secretsmanager', 'describe-secret', '--secret-id', arn,
                                 '--region', 'ap-northeast-2', '--query', '{ARN:ARN,VersionIdsToStages:VersionIdsToStages,DeletedDate:DeletedDate}',
                                 '--output', 'json', '--no-cli-pager'], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=20, check=False)
        if result.returncode:
            raise Unknown('secret_version_metadata_unavailable')
        return json.loads(result.stdout)


def histories(sources):
    return {schema: sources.pg(f"SELECT coalesce(json_agg(row_to_json(x) ORDER BY installed_rank),'[]'::json) FROM "
                              f"(SELECT installed_rank,version,script,checksum,success FROM {schema}.flyway_schema_history) x")
            for schema in SCHEMAS}


def validate_migrations(actual, expected, schemas):
    for schema in schemas:
        rows = actual[schema]
        if any(row.get('success') is not True for row in rows):
            raise Failed('flyway_unsuccessful_history')
        applied = [{key: row[key] for key in ('version', 'script', 'checksum')} for row in rows if row.get('version') is not None]
        wanted = [{key: row[key] for key in ('version', 'script', 'checksum')} for row in expected[schema]]
        # 문자열 version의 순서에 의존하지 않고 집합 전체·중복을 함께 비교한다.
        if sorted(applied, key=canonical) != sorted(wanted, key=canonical):
            raise Failed('flyway_contract_mismatch')


def schema_fingerprint(sources):
    """선언 hash 대신 catalog의 실제 정의 전체를 읽는다. row data·secret value는 수집하지 않는다."""
    pg = sources.pg("""SELECT coalesce(json_agg(row_to_json(x) ORDER BY kind,identity),'[]'::json) FROM (
      SELECT 'column' kind, n.nspname||'.'||c.relname||'.'||a.attnum identity,
        json_build_array(a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,
          a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) definition
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'constraint',n.nspname||'.'||c.conrelid::regclass::text||'.'||c.conname,
        to_json(pg_get_constraintdef(c.oid,true)) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
        WHERE n.nspname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'index',schemaname||'.'||indexname,to_json(indexdef) FROM pg_indexes
        WHERE schemaname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'view',schemaname||'.'||viewname,to_json(definition) FROM pg_views
        WHERE schemaname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'materialized_view',schemaname||'.'||matviewname,to_json(definition) FROM pg_matviews
        WHERE schemaname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'extension',extname,json_build_array(extversion,extnamespace::regnamespace::text) FROM pg_extension
      UNION ALL SELECT 'routine',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
        to_json(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('enrollment','telemetry_ops','dashboard_cache') AND p.prokind IN ('f','p')
      UNION ALL SELECT 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,to_json(pg_get_triggerdef(t.oid,true))
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'sequence',schemaname||'.'||sequencename,
        json_build_array(data_type,start_value,min_value,max_value,increment_by,cycle,cache_size) FROM pg_sequences
        WHERE schemaname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'enum',n.nspname||'.'||t.typname||'.'||e.enumsortorder,to_json(e.enumlabel)
        FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
        WHERE n.nspname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'policy',schemaname||'.'||tablename||'.'||policyname,
        json_build_array(permissive,roles,cmd,qual,with_check) FROM pg_policies
        WHERE schemaname IN ('enrollment','telemetry_ops','dashboard_cache')
      UNION ALL SELECT 'relation',n.nspname||'.'||c.relname,json_build_array(c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.reloptions)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('enrollment','telemetry_ops','dashboard_cache')
    ) x""")
    if not pg:
        raise Unknown('postgres_schema_empty')
    ch = sources.ch("SELECT database,name,engine,create_table_query FROM system.tables "
                    "WHERE database IN ({source:String},'dashboard_cache') ORDER BY database,name FORMAT JSONEachRow",
                    {'param_source': sources.config['clickhouse']['database']})
    if not ch:
        raise Unknown('clickhouse_schema_empty')
    history = histories(sources)
    return digest({'postgres': pg, 'histories': history, 'clickhouse': ch})


def fingerprints(sources, contract):
    deployments = {}
    current_pods = {}
    pods = sources.kube('/api/v1/namespaces/pulsemetry-dev/pods')['items']
    for app in APPS:
        obj = sources.kube('/apis/apps/v1/namespaces/pulsemetry-dev/deployments/' + app)
        spec = obj['spec']['template']['spec']
        # 이미지·replica는 B의 대상이다. 실제 비이미지 실행 설정만 비교한다.
        spec = json.loads(json.dumps(spec))
        for container in spec.get('containers', []) + spec.get('initContainers', []):
            container.pop('image', None)
        deployments[app] = {'spec': spec, 'annotations': obj['spec']['template'].get('metadata', {}).get('annotations', {})}
        selector = obj['spec']['selector']['matchLabels']
        selected = [pod for pod in pods if all(pod['metadata'].get('labels', {}).get(key) == value for key, value in selector.items())
                    and not pod['metadata'].get('deletionTimestamp')]
        if len(selected) != obj['spec'].get('replicas', 1) or not selected:
            raise Unknown('current_pod_set_unavailable')
        for pod in selected:
            if pod.get('status', {}).get('phase') != 'Running' or not any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in pod['status'].get('conditions', [])):
                raise Unknown('current_pod_not_ready')
            current_pods[pod['metadata']['name']] = pod
    spcs = {name: sources.kube('/apis/secrets-store.csi.x-k8s.io/v1/namespaces/pulsemetry-dev/secretproviderclasses/' + name)['spec'] for name in SPCS}
    statuses = sources.kube('/apis/secrets-store.csi.x-k8s.io/v1/namespaces/pulsemetry-dev/secretproviderclasspodstatuses')['items']
    mounted = mounted_versions(current_pods, statuses)
    selected_before = selected_secret_versions(sources, spcs, mounted)
    schema = schema_fingerprint(sources)
    tls = {}
    for name in TLS_SECRETS:
        meta = sources.kube('/api/v1/namespaces/pulsemetry-dev/secrets/' + name, metadata=True)['metadata']
        tls[name] = {'uid': meta['uid'], 'resourceVersion': meta['resourceVersion']}
    selected_after = selected_secret_versions(sources, spcs, mounted)
    if selected_before != selected_after:
        raise Unknown('secret_version_changed_during_snapshot')
    return {'schemaFingerprint': schema,
            'runtimeFingerprint': digest(deployments), 'keyTlsFingerprint': digest({'spc': spcs, 'mounted': mounted, 'selected': selected_after, 'tls': tls}),
            'envelopeFingerprint': digest(contract['compatibility']['envelope'])}


def mounted_versions(pods, statuses):
    mounted, expected = {}, set()
    for name, pod in pods.items():
        for volume in pod['spec'].get('volumes', []):
            spc = volume.get('csi', {}).get('volumeAttributes', {}).get('secretProviderClass')
            if spc in SPCS:
                expected.add((name, spc))
    seen = set()
    for item in statuses:
        status = item.get('status', {})
        pair = (status.get('podName'), status.get('secretProviderClassName'))
        if pair not in expected:
            continue
        pod = pods[pair[0]]
        if pair in seen or status.get('mounted') is not True or not any(owner.get('kind') == 'Pod' and owner.get('uid') == pod['metadata']['uid'] for owner in item['metadata'].get('ownerReferences', [])):
            raise Unknown('mounted_secret_status_unbound')
        objects = sorted([{'id': row['id'], 'version': row['version']} for row in status.get('objects', [])], key=lambda row: row['id'])
        if not objects or any(not row['id'] or not row['version'] for row in objects) or len({row['id'] for row in objects}) != len(objects):
            raise Unknown('mounted_secret_version_missing')
        if pair[1] in mounted and mounted[pair[1]] != objects:
            raise Unknown('mounted_secret_versions_diverged')
        mounted[pair[1]] = objects
        seen.add(pair)
    if seen != expected or set(mounted) != set(SPCS):
        raise Unknown('mounted_secret_set_incomplete')
    return mounted


def selected_secret_versions(sources, spcs, mounted):
    """ASCP GetFileName(objectAlias 및 jmesPath alias) 규칙을 따라 선택 버전과 mount를 대조한다."""
    metadata, selected = {}, {}
    for name, spec in spcs.items():
        params = spec.get('parameters', {})
        if spec.get('provider') != 'aws' or params.get('failoverRegion') or params.get('pathTranslation', '_') != '_':
            raise Unknown('spc_provider_contract_unsupported')
        descriptors = parse_yaml(params['objects'])
        if not isinstance(descriptors, list) or not descriptors:
            raise Unknown('spc_objects_invalid')
        by_alias = {row['id']: row['version'] for row in mounted[name]}
        expected_aliases, selected[name] = set(), []
        for descriptor in descriptors:
            if not isinstance(descriptor, dict) or set(descriptor) - {'objectName', 'objectType', 'objectAlias', 'objectVersion', 'objectVersionLabel', 'filePermission', 'jmesPath'}:
                raise Unknown('spc_object_contract_unsupported')
            arn = descriptor.get('objectName', '')
            if not isinstance(arn, str) or not re.fullmatch(r'arn:aws:secretsmanager:ap-northeast-2:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}', arn) or descriptor.get('objectType', 'secretsmanager') != 'secretsmanager':
                raise Unknown('spc_exact_secret_arn_required')
            if arn not in metadata:
                metadata[arn] = sources.describe_secret(arn)
            meta = metadata[arn]
            if meta.get('ARN') != arn or meta.get('DeletedDate') or not isinstance(meta.get('VersionIdsToStages'), dict):
                raise Unknown('secret_version_metadata_invalid')
            versions = meta['VersionIdsToStages']
            if any(not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9-]{32,64}', version)
                   or not isinstance(stages, list) or any(not isinstance(stage, str) for stage in stages)
                   for version, stages in versions.items()):
                raise Unknown('secret_version_metadata_invalid')
            pinned = descriptor.get('objectVersion')
            label = descriptor.get('objectVersionLabel', 'AWSCURRENT')
            if pinned:
                if pinned not in versions or ('objectVersionLabel' in descriptor and label not in versions[pinned]):
                    raise Unknown('pinned_secret_version_unavailable')
                version = pinned
            else:
                candidates = [version for version, stages in versions.items() if label in stages]
                if len(candidates) != 1:
                    raise Unknown('secret_version_stage_ambiguous')
                version = candidates[0]
            aliases = [descriptor.get('objectAlias', arn).replace('/', '_')]
            for entry in descriptor.get('jmesPath', []):
                if not isinstance(entry, dict) or not isinstance(entry.get('objectAlias'), str) or not isinstance(entry.get('path'), str):
                    raise Unknown('spc_jmespath_alias_invalid')
                aliases.append(entry['objectAlias'].replace('/', '_'))
            if any(alias in expected_aliases or by_alias.get(alias) != version for alias in aliases) or len(set(aliases)) != len(aliases):
                raise Unknown('selected_secret_version_not_mounted')
            expected_aliases.update(aliases)
            selected[name].append({'arn': arn, 'versionId': version, 'aliases': sorted(aliases)})
        if set(by_alias) != expected_aliases:
            raise Unknown('mounted_secret_alias_set_mismatch')
        selected[name].sort(key=lambda row: (row['arn'], row['versionId'], row['aliases']))
    return selected


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--credential-file', type=Path)
    parser.add_argument('--contract', type=Path)
    parser.add_argument('--all-fingerprints', action='store_true')
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        credentials = json.loads(args.credential_file.read_text() if args.credential_file else os.environ['DELIVERY_PROBE_CREDENTIAL_JSON'])
        sources = Sources(config, credentials)
        result = fingerprints(sources, json.loads(args.contract.read_text())) if args.all_fingerprints else {'schemaFingerprint': schema_fingerprint(sources)}
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
        return 0
    except Unknown as error:
        print(json.dumps({'result': 'unknown', 'reason': str(error)}, separators=(',', ':')))
        return 2
    except Exception:
        print('{"result":"unknown","reason":"snapshot_unavailable"}')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
