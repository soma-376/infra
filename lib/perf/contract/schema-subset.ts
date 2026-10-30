import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';

/**
 * perf 환경 계약 v2 검사기. 계약 원본은 telemetry-load-tests `docs/contracts/infra-environment.md`와 `schemas/v2/`다.
 * JSON Schema 2020-12의 부분집합만 받고, load-tests의 Python 검사기(`tools/contract.py`)와 같은
 * `(JSON Pointer, 키워드)` 오류 집합을 낸다. 규칙을 바꾸면 양쪽을 함께 바꾸고 공유 사본을 다시 내보낸다.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SchemaError = readonly [path: string, keyword: string];
type SchemaNode = boolean | { [key: string]: any };

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description']);
const KEYWORDS = new Set([
  '$defs', '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'propertyNames',
  'minProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum',
  'maximum', 'exclusiveMinimum', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'string', 'number', 'integer']);
const PATTERN_BANNED = /\\[dDwWsSbB]/;

export class ContractError extends Error {}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Python 검사기처럼 잘못된 UTF-8을 대체 문자로 바꾸지 않고 거부한다. */
export function parseJsonBytes(data: Uint8Array, label: string): JsonValue {
  try {
    const text = decoder.decode(data);
    const value = JSON.parse(text) as JsonValue;
    load(text, { schema: JSON_SCHEMA }); // JSON.parse가 덮어쓴 중복 key도 별도 파서로 거부한다.
    return value;
  } catch (error) {
    throw new ContractError(`JSON 파싱 실패: ${label}: ${(error as Error).message}`);
  }
}

/** `\d`·`\w`·`\s`·`\b`는 언어마다 Unicode 처리가 달라 금지한다. `$`는 패턴 끝에만 둔다. */
function compilePattern(pattern: unknown, where: string): RegExp {
  if (typeof pattern !== 'string' || PATTERN_BANNED.test(pattern)) {
    throw new ContractError(`pattern은 명시 ASCII 문자 클래스만 쓴다: ${where}`);
  }
  const body = pattern.endsWith('$') && !pattern.endsWith('\\$') ? pattern.slice(0, -1) : pattern;
  if (body.split('\\$').join('').includes('$')) {
    throw new ContractError(`pattern의 $는 끝에만 둔다: ${where}`);
  }
  return new RegExp(pattern, 'u');
}

function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function typeMatches(value: unknown, name: string): boolean {
  switch (name) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return isNumber(value);
    default: return isNumber(value) && Number.isInteger(value);
  }
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return left === right;
}

function pointerJoin(path: string, token: string | number): string {
  return `${path}/${String(token).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function compareErrors(a: SchemaError, b: SchemaError): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/** 한 디렉터리의 *.schema.json 묶음. `$ref`는 같은 디렉터리 파일의 `#/$defs/<이름>`만 허용한다. */
export class Schemas {
  private readonly documents = new Map<string, { [key: string]: any }>();
  private readonly patterns = new Map<string, RegExp>();

  constructor(directory: string) {
    for (const name of readdirSync(directory).filter(file => file.endsWith('.schema.json')).sort()) {
      const document = parseJsonBytes(readFileSync(join(directory, name)), name);
      if (!isObject(document) || document.$id !== name) throw new ContractError(`$id가 파일 이름과 다르다: ${name}`);
      this.documents.set(name, document);
    }
    if (this.documents.size === 0) throw new ContractError(`schema가 없다: ${directory}`);
    for (const [name, document] of this.documents) this.checkSchema(document, name, '#');
  }

  private checkSchema(schema: SchemaNode, document: string, where: string): void {
    if (typeof schema === 'boolean') return;
    if (!isObject(schema)) throw new ContractError(`schema는 객체나 boolean이어야 한다: ${document}${where}`);
    for (const [key, value] of Object.entries(schema)) {
      if (ANNOTATIONS.has(key)) continue;
      if (!KEYWORDS.has(key)) throw new ContractError(`지원하지 않는 키워드 ${key}: ${document}${where}`);
      const here = `${where}/${key}`;
      switch (key) {
        case 'properties':
        case '$defs':
          if (!isObject(value)) throw new ContractError(`${key}는 객체다: ${document}${here}`);
          for (const [name, child] of Object.entries(value)) this.checkSchema(child as SchemaNode, document, `${here}/${name}`);
          break;
        case 'additionalProperties': case 'propertyNames': case 'items': case 'not': case 'if': case 'then': case 'else':
          this.checkSchema(value as SchemaNode, document, here);
          break;
        case 'allOf': case 'anyOf': case 'oneOf':
          if (!Array.isArray(value) || value.length === 0) throw new ContractError(`${key}는 비어 있지 않은 배열이다: ${document}${here}`);
          value.forEach((child, index) => this.checkSchema(child as SchemaNode, document, `${here}/${index}`));
          break;
        case 'type': {
          const names = Array.isArray(value) ? value : [value];
          if (names.length === 0 || names.some(name => !TYPES.has(name as string))) throw new ContractError(`알 수 없는 type: ${document}${here}`);
          break;
        }
        case 'required':
          if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new ContractError(`required는 문자열 배열이다: ${document}${here}`);
          break;
        case 'enum':
          if (!Array.isArray(value) || value.length === 0) throw new ContractError(`enum은 비어 있지 않은 배열이다: ${document}${here}`);
          break;
        case 'pattern':
          this.patterns.set(value as string, compilePattern(value, `${document}${here}`));
          break;
        case 'minProperties': case 'minItems': case 'maxItems': case 'minLength': case 'maxLength':
          if (!Number.isInteger(value) || (value as number) < 0) throw new ContractError(`${key}는 0 이상의 정수다: ${document}${here}`);
          break;
        case 'minimum': case 'maximum': case 'exclusiveMinimum':
          if (!isNumber(value)) throw new ContractError(`${key}는 수다: ${document}${here}`);
          break;
        case 'uniqueItems':
          if (typeof value !== 'boolean') throw new ContractError(`uniqueItems는 boolean이다: ${document}${here}`);
          break;
        case '$ref':
          this.resolve(value, document);
          break;
        default:
          break;
      }
    }
  }

  private resolve(reference: unknown, document: string): [SchemaNode, string] {
    if (typeof reference !== 'string' || !reference.includes('#')) throw new ContractError(`$ref 형식 오류: ${String(reference)}`);
    const index = reference.indexOf('#');
    const target = reference.slice(0, index) || document;
    const fragment = reference.slice(index + 1);
    const node = this.documents.get(target);
    if (node === undefined) throw new ContractError(`$ref 대상 파일이 없다: ${reference} (${document})`);
    if (!fragment) return [node, target];
    if (!fragment.startsWith('/$defs/') || fragment.split('/').length !== 3) throw new ContractError(`$ref는 #/$defs/<이름>만 허용한다: ${reference}`);
    const name = fragment.slice('/$defs/'.length);
    const definitions = node.$defs ?? {};
    if (!Object.hasOwn(definitions, name)) throw new ContractError(`$ref 대상 정의가 없다: ${reference} (${document})`);
    return [definitions[name], target];
  }

  validate(name: string, instance: JsonValue): SchemaError[] {
    const file = name.endsWith('.schema.json') ? name : `${name}.schema.json`;
    const document = this.documents.get(file);
    if (document === undefined) throw new ContractError(`알 수 없는 schema: ${name}`);
    const errors = new Map<string, SchemaError>();
    this.check(document, file, instance, '', errors);
    return [...errors.values()].sort(compareErrors);
  }

  private isValid(schema: SchemaNode, document: string, instance: unknown): boolean {
    const errors = new Map<string, SchemaError>();
    this.check(schema, document, instance, '', errors);
    return errors.size === 0;
  }

  private check(schema: SchemaNode, document: string, instance: unknown, path: string, errors: Map<string, SchemaError>): void {
    const add = (where: string, keyword: string) => errors.set(`${where}\u0000${keyword}`, [where, keyword]);
    if (schema === true) return;
    if (schema === false) { add(path, 'false'); return; }
    if ('$ref' in schema) {
      const [target, targetDocument] = this.resolve(schema.$ref, document);
      this.check(target, targetDocument, instance, path, errors);
    }
    if ('type' in schema) {
      const names: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!names.some(name => typeMatches(instance, name))) add(path, 'type');
    }
    if ('enum' in schema && !(schema.enum as unknown[]).some(item => jsonEqual(instance, item))) add(path, 'enum');
    if ('const' in schema && !jsonEqual(instance, schema.const)) add(path, 'const');
    if (isObject(instance)) this.checkObject(schema, document, instance, path, errors, add);
    if (Array.isArray(instance)) this.checkArray(schema, document, instance, path, errors, add);
    if (typeof instance === 'string') {
      const length = [...instance].length;
      if ('minLength' in schema && length < schema.minLength) add(path, 'minLength');
      if ('maxLength' in schema && length > schema.maxLength) add(path, 'maxLength');
      if ('pattern' in schema && !this.patterns.get(schema.pattern)!.test(instance)) add(path, 'pattern');
    }
    if (isNumber(instance)) {
      if ('minimum' in schema && instance < schema.minimum) add(path, 'minimum');
      if ('maximum' in schema && instance > schema.maximum) add(path, 'maximum');
      if ('exclusiveMinimum' in schema && instance <= schema.exclusiveMinimum) add(path, 'exclusiveMinimum');
    }
    for (const child of (schema.allOf ?? []) as SchemaNode[]) this.check(child, document, instance, path, errors);
    if ('anyOf' in schema && !(schema.anyOf as SchemaNode[]).some(child => this.isValid(child, document, instance))) add(path, 'anyOf');
    if ('oneOf' in schema && (schema.oneOf as SchemaNode[]).filter(child => this.isValid(child, document, instance)).length !== 1) add(path, 'oneOf');
    if ('not' in schema && this.isValid(schema.not, document, instance)) add(path, 'not');
    if ('if' in schema) {
      const branch = this.isValid(schema.if, document, instance) ? 'then' : 'else';
      if (branch in schema) this.check(schema[branch], document, instance, path, errors);
    }
  }

  private checkObject(schema: { [key: string]: any }, document: string, instance: { [key: string]: JsonValue }, path: string,
    errors: Map<string, SchemaError>, add: (where: string, keyword: string) => void): void {
    const properties = (schema.properties ?? {}) as { [key: string]: SchemaNode };
    for (const name of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(instance, name)) add(pointerJoin(path, name), 'required');
    }
    if ('minProperties' in schema && Object.keys(instance).length < schema.minProperties) add(path, 'minProperties');
    for (const [key, value] of Object.entries(instance)) {
      const childPath = pointerJoin(path, key);
      if ('propertyNames' in schema && !this.isValid(schema.propertyNames, document, key)) add(childPath, 'propertyNames');
      if (Object.hasOwn(properties, key)) {
        this.check(properties[key], document, value, childPath, errors);
      } else if ('additionalProperties' in schema) {
        if (schema.additionalProperties === false) add(childPath, 'additionalProperties');
        else this.check(schema.additionalProperties, document, value, childPath, errors);
      }
    }
  }

  private checkArray(schema: { [key: string]: any }, document: string, instance: JsonValue[], path: string,
    errors: Map<string, SchemaError>, add: (where: string, keyword: string) => void): void {
    if ('minItems' in schema && instance.length < schema.minItems) add(path, 'minItems');
    if ('maxItems' in schema && instance.length > schema.maxItems) add(path, 'maxItems');
    if (schema.uniqueItems === true && instance.some((item, index) => instance.slice(0, index).some(other => jsonEqual(item, other)))) {
      add(path, 'uniqueItems');
    }
    if ('items' in schema) instance.forEach((item, index) => this.check(schema.items, document, item, pointerJoin(path, index), errors));
  }
}

/** 환경 교환 버전만 dispatch한다. run-plan/journal/verdict v2와 독립이다. */
export function environmentSchemas(version: unknown): Schemas {
  if (version !== 2 && version !== 3) throw new ContractError('지원하지 않는 환경 계약 버전');
  return new Schemas(resolve(__dirname, `../../../test/fixtures/perf-contract-v${version}/schemas`));
}
