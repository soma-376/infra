-- 현재 원하는 source·revision의 적용이 확인되어야 다음 wave를 연다.
local function state(status, message)
  return { status = status, message = message }
end
local function same(left, right)
  if type(left) ~= type(right) then return false end
  if type(left) ~= "table" then return left == right end
  for key, value in pairs(left) do
    if not same(value, right[key]) then return false end
  end
  for key, _ in pairs(right) do
    if left[key] == nil then return false end
  end
  return true
end
local function immutable(revision)
  -- 생성기가 lowercase SHA 문법을 검증하며 아래에서는 Argo가 적용한 SHA와 정확히 대조한다.
  -- 160bit SHA를 tonumber로 변환하면 gopher-lua 정수 범위를 넘어 정상 SHA도 거부된다.
  return type(revision) == "string" and #revision == 40
end
local metadata = obj.metadata or {}
local annotations = metadata.annotations or {}
if annotations["argocd.argoproj.io/skip-reconcile"] == "true" or annotations["pulsemetry.io/handoff-status"] == "blocked" then
  return state("Suspended", "인계가 차단된 검토용 Application이다")
end
local spec = obj.spec or {}
local status = obj.status or {}
if obj.operation ~= nil then return state("Progressing", "동기화 요청이 진행 중이다") end
local operation = status.operationState
if operation ~= nil then
  local phase = operation.phase
  if phase ~= "Succeeded" and phase ~= "Failed" and phase ~= "Error" then
    return state("Progressing", "동기화 operation의 완료를 확인하지 못했다")
  end
  if phase == "Failed" or phase == "Error" then
    local result = operation.syncResult or {}
    local current = false
    if type(spec.sources) == "table" and type(result.revisions) == "table" and #spec.sources == #result.revisions then
      current = #spec.sources > 0
      for index, source in ipairs(spec.sources) do
        if source.targetRevision ~= result.revisions[index] then current = false end
      end
    elseif spec.source ~= nil then
      current = immutable(spec.source.targetRevision) and result.revision == spec.source.targetRevision
    end
    if current then return state("Degraded", "현재 revision의 동기화 operation이 실패했다") end
  end
end
local errors = { ComparisonError = true, InvalidSpecError = true, SyncError = true, UnknownError = true }
for _, condition in ipairs(status.conditions or {}) do
  if errors[condition.type] then
    return state("Degraded", "Application 오류 condition이 있다")
  end
end
local sync = status.sync or {}
local compared = sync.comparedTo or {}
-- 렌더 결과가 같으면 새 V에도 자동 sync가 생략될 수 있다.
-- 이전 terminal operation 또는 operation 부재를 허용하고 현재 source·비교 revision·건강 상태를 확인한다.
if not same(spec.destination, compared.destination) then return state("Progressing", "현재 destination의 비교 결과가 없다") end
if spec.sources ~= nil then
  if #spec.sources == 0 or spec.source ~= nil or not same(spec.sources, compared.sources) then
    return state("Progressing", "현재 sources의 비교 결과가 없다")
  end
  if type(sync.revisions) ~= "table" or #sync.revisions ~= #spec.sources then return state("Progressing", "source별 revision 증거가 없다") end
  for index, source in ipairs(spec.sources) do
    if not immutable(source.targetRevision) or sync.revisions[index] ~= source.targetRevision then
      return state("Progressing", "원하는 고정 source revision이 적용되지 않았다")
    end
  end
elseif spec.source ~= nil then
  if not immutable(spec.source.targetRevision) or not same(spec.source, compared.source) or sync.revision ~= spec.source.targetRevision then
    return state("Progressing", "원하는 고정 source revision이 적용되지 않았다")
  end
else
  return state("Progressing", "source 선언이 없다")
end
if sync.status ~= "Synced" then return state("Progressing", "원하는 revision이 Synced 상태가 아니다") end
local health = (status.health or {}).status
if health == "Degraded" then return state("Degraded", "하위 리소스가 Degraded 상태다") end
if health ~= "Healthy" then return state("Progressing", "하위 리소스의 Healthy를 확인하지 못했다") end
return state("Healthy", "현재 고정 revision이 Synced·Healthy다. 별도 기능 검증은 수행하지 않는다")
