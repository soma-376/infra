import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PerfInputError } from './deploy-inputs';

/**
 * perf 보조 script의 공통 인자·출력 처리. 범용 CLI가 아니다(PLAN §4.3). 옵션은 `--key value` 쌍이고
 * 반복 옵션은 `repeat`에 적는다. 결과 파일은 새로 만들기만 하고 덮어쓰지 않는다.
 */
export function parseOptions(argv: readonly string[], allowed: readonly string[], repeat: readonly string[] = [], usage = ''): Record<string, string[]> {
  const options: Record<string, string[]> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(key) || value === undefined || value.startsWith('--')) throw new PerfInputError(`사용법: ${usage}`);
    if (options[key] && !repeat.includes(key)) throw new PerfInputError(`${key} 옵션이 중복된다`);
    (options[key] ??= []).push(value);
  }
  return options;
}

export function required(options: Record<string, string[]>, key: string): string {
  const value = options[key]?.[0];
  if (value === undefined) throw new PerfInputError(`${key} 옵션이 필요하다`);
  return value;
}

export function readBytes(path: string): Buffer {
  return readFileSync(resolve(path));
}

/** 같은 이름이 있으면 실패한다(`wx`). 이미 hash로 참조한 결과 파일을 덮어쓰지 않는다. */
export function writeNew(path: string, text: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), text, { flag: 'wx', mode: 0o644 });
}

export function run(main: () => void): void {
  try {
    main();
  } catch (error) {
    if (error instanceof PerfInputError || (error instanceof Error && /EEXIST/.test(error.message))) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}
