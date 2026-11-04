-- Kafka·KafkaTopic·KafkaUser는 이전 generation의 Ready를 현재 성공으로 쓰지 않는다.
local status = obj.status or {}
local generation = (obj.metadata or {}).generation
if type(generation) ~= "number" or status.observedGeneration ~= generation then
  return { status = "Progressing", message = "현재 generation을 관측하지 못했다" }
end
local ready = false
for _, condition in ipairs(status.conditions or {}) do
  if condition.type == "NotReady" and condition.status == "True" then
    return { status = "Degraded", message = "현재 generation이 NotReady 상태다" }
  end
  if condition.type == "Ready" and condition.status == "True" then ready = true end
end
if ready then return { status = "Healthy", message = "현재 generation이 Ready 상태다" } end
return { status = "Progressing", message = "현재 generation의 Ready를 확인하지 못했다" }
