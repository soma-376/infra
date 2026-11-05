-- 인증서/Issuer의 과거 Ready로 LBC 인계를 진행하지 않는다.
-- Ready는 실제 serving certificate·CA 주입·webhook 기능 검증을 대체하지 않는다.
local function state(status, message)
  return { status = status, message = message }
end
local metadata = obj.metadata or {}
if metadata.deletionTimestamp ~= nil then return state("Progressing", "인증서 리소스가 삭제 중이다") end
if type(metadata.generation) ~= "number" then return state("Progressing", "현재 generation을 확인하지 못했다") end
local ready = nil
for _, condition in ipairs((obj.status or {}).conditions or {}) do
  if condition.observedGeneration == metadata.generation then
    if condition.type == "Issuing" and condition.status == "True" then
      return state("Progressing", "현재 generation의 인증서를 발급 중이다")
    end
    if condition.type == "Ready" then ready = condition.status end
  end
end
if ready == "False" then return state("Degraded", "현재 generation의 인증서 또는 Issuer가 준비되지 않았다") end
if ready ~= "True" then return state("Progressing", "현재 generation의 Ready를 확인하지 못했다") end
return state("Healthy", "현재 generation이 Ready다. 실제 TLS·CA 주입은 별도 검증한다")
