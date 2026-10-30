import { PERF_ENVIRONMENT_TAG, PERF_EVIDENCE_TAG } from './config';
import { JsonObject, fail, isObject } from './deploy-inputs';
import { JsonValue } from './contract/schema-subset';

/**
 * 삭제 뒤 잔존 확인. `aws resourcegroupstaggingapi get-resources --tag-filters Key=pulsemetry:perf-environment,Values=<id>`와
 * `aws cloudformation describe-stacks` 결과만 읽는다. 단순 `cdk destroy` 성공을 정리 완료로 보지 않는다(PLAN §10).
 */
export interface ResidualReport {
  readonly environment_id: string;
  readonly checked: { readonly stacks: number; readonly tagged: number };
  /** 남아 있으면 안 되는 자원. 비어 있어야 정리 완료다. */
  readonly residual: readonly { readonly arn: string; readonly reason: string }[];
  /** 보존하기로 한 자원(evidence). 소유자·만료를 확인한다. */
  readonly retained: readonly string[];
  readonly complete: boolean;
}

const DELETED = new Set(['DELETE_COMPLETE']);

export function residualReport(environmentId: string, tagged: JsonValue, stacks: readonly JsonValue[], ownedCleanup = false): ResidualReport {
  if (!isObject(tagged) || !Array.isArray(tagged.ResourceTagMappingList) || tagged.PaginationToken) {
    fail('tagged: pagination이 끝난 get-resources 결과가 필요하다');
  }
  const residual: { arn: string; reason: string }[] = [];
  const retained: string[] = [];
  for (const item of tagged.ResourceTagMappingList) {
    if (!isObject(item) || typeof item.ResourceARN !== 'string' || !Array.isArray(item.Tags)) fail('tagged: ResourceARN·Tags가 필요하다');
    const tags = Object.fromEntries(item.Tags.filter(isObject).map(tag => [String(tag.Key), String(tag.Value)]));
    if (!ownedCleanup && tags[PERF_EVIDENCE_TAG] === 'shared') { retained.push(item.ResourceARN); continue; }
    if (tags[PERF_ENVIRONMENT_TAG] !== environmentId) fail(`tagged: 다른 환경의 자원이 섞였다: ${item.ResourceARN}`);
    residual.push({ arn: item.ResourceARN, reason: '소유 태그가 남아 있다' });
  }
  let checkedStacks = 0;
  for (const document of stacks) {
    if (!isObject(document) || !Array.isArray(document.Stacks)) fail('stacks: describe-stacks 결과가 필요하다');
    for (const stack of document.Stacks) {
      if (!isObject(stack) || typeof stack.StackName !== 'string') fail('stacks: StackName이 필요하다');
      checkedStacks++;
      if (!ownedCleanup && stack.StackName === 'PerfEvidenceStack') continue;
      if (!DELETED.has(String(stack.StackStatus))) residual.push({ arn: String(stack.StackId ?? stack.StackName), reason: `스택 상태 ${String(stack.StackStatus)}` });
    }
  }
  return {
    environment_id: environmentId, checked: { stacks: checkedStacks, tagged: tagged.ResourceTagMappingList.length },
    residual, retained: retained.sort(), complete: residual.length === 0,
  };
}

export type { JsonObject };
