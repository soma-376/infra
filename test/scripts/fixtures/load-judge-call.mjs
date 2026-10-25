// stdin의 {fn, args}로 판정 함수를 부르고 결과를 JSON으로 낸다(observability-load-judge 회귀 시험용).
import { readFileSync } from 'node:fs';
import * as judge from '../../../scripts/lib/observability-load-judge.mjs';

const { fn, args } = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(judge[fn](...args)));
