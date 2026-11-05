"""기존 observability-smoke의 고정 synthetic OTLP 및 id-v1 oracle. 원문 데이터는 쓰지 않는다."""
import datetime as dt
import hashlib
import json
import uuid

def payload(run_id, source_time):
    """같은 run ID·source time에는 같은 바이트와 native ID를 만든다. 원문 프롬프트는 넣지 않는다."""
    run_id = uuid.UUID(str(run_id))
    stamp = dt.datetime.fromisoformat(source_time.replace("Z", "+00:00"))
    if stamp.utcoffset() is None:
        raise ValueError("source time requires timezone")
    stamp = stamp.astimezone(dt.timezone.utc)
    delta = stamp - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    nanos = ((delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds) * 1000
    request_id = "req_smoke_" + run_id.hex
    attrs = {
        "session.id": str(run_id), "event.timestamp": stamp.isoformat(),
        "prompt.id": str(uuid.uuid5(run_id, "prompt")), "event.name": "api_request", "event.sequence": "1",
        "model": "claude-haiku-4-5-20251001", "input_tokens": {"intValue": "1066"}, "output_tokens": {"intValue": "28"},
        "cache_read_tokens": {"intValue": "0"}, "cache_creation_tokens": {"intValue": "0"}, "cost_usd": {"doubleValue": 0.001206},
        "duration_ms": {"intValue": "1056"}, "ttft_ms": {"intValue": "738"}, "request_id": request_id,
        "client_request_id": str(uuid.uuid5(run_id, "client")),
    }
    record = {"timeUnixNano": str(nanos), "observedTimeUnixNano": str(nanos),
              "body": {"stringValue": "claude_code.api_request"},
              "attributes": [{"key": k, "value": v if isinstance(v, dict) else {"stringValue": v}} for k, v in attrs.items()]}
    data = {"resourceLogs": [{"resource": {"attributes": [
        {"key": "service.name", "value": {"stringValue": "claude-code"}},
        {"key": "service.version", "value": {"stringValue": "2.1.290"}}]},
        "scopeLogs": [{"scope": {"name": "com.anthropic.claude_code.events", "version": "2.1.290"}, "logRecords": [record]}]}]}
    return json.dumps(data, separators=(",", ":")).encode(), request_id


def expected_observation_id(body, tenant, installation):
    """이 고정 logs fixture만 지원하는 id-v1 fingerprint oracle(ADR0020, stamp-v1).

    Claude api_request의 request_id는 관측 고유 ID가 아니다. proto 필드명·숫자·KeyValue 정렬과
    서버 신원 stamp를 반영한 fingerprint를 구한다. 임의 OTLP canonicalizer로 사용하지 않는다.
    """
    data = json.loads(body)["resourceLogs"][0]
    resource = data["resource"]
    resource["attributes"] += [{"key": key, "value": {"stringValue": str(value)}}
                               for key, value in [("tenant.id", tenant), ("developer.installation_id", installation)]]
    scope = data["scopeLogs"][0]["scope"]
    record = data["scopeLogs"][0]["logRecords"][0]
    names = {"stringValue": "string_value", "doubleValue": "double_value", "intValue": "int_value",
             "timeUnixNano": "time_unix_nano", "observedTimeUnixNano": "observed_time_unix_nano"}
    def canonical(value):
        if not isinstance(value, dict):
            return value
        result = {}
        for name in sorted(value, key=lambda key: names.get(key, key)):
            item = value[name]
            if name == "attributes":
                item = sorted([canonical(attr) for attr in item], key=lambda attr: json.dumps(attr, separators=(",", ":")))
            elif name in ("timeUnixNano", "observedTimeUnixNano", "intValue"):
                item = int(item)
            else:
                item = canonical(item)
            result[names.get(name, name)] = item
        return result
    material = {"identity_version": "id-v1", "installation_id": str(installation), "kind": "fingerprint",
                "service_name": "claude-code", "signal": "log", "source_time": int(record["timeUnixNano"]),
                "tenant_id": str(tenant), "record": canonical(record), "resource": canonical(resource),
                "resource_schema_url": "", "scope": canonical(scope), "scope_schema_url": ""}
    return hashlib.sha256(json.dumps(material, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
