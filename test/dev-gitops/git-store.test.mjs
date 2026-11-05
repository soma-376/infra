import test from 'node:test';
import assert from 'node:assert/strict';
import { repository } from './fixtures.mjs';

const evidencePath = nonce => `dev/evidence/${nonce.repeat(32)}.json`;

test('실제 bare Git의 두 writer가 같은 HEAD를 CAS하면 한 commit만 승리한다', async t => {
  const fixture = await repository(t), second = await fixture.clone('contender');
  const results = await Promise.allSettled([
    fixture.store.cas(fixture.Q, new Map([[evidencePath('1'), '{"writer":1}\n']]), 'writer one'),
    second.cas(fixture.Q, new Map([[evidencePath('2'), '{"writer":2}\n']]), 'writer two'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.equal(await fixture.store.refresh(), winner);
  assert.equal(await second.refresh(), winner);
  const files = await fixture.store.files(winner);
  assert.equal([evidencePath('1'), evidencePath('2')].filter(path => files.has(path)).length, 1);
  assert.equal(await fixture.store.git(['rev-list', '--count', `${fixture.Q}..${winner}`]), '1');
});

test('성공한 push 응답 유실은 원격 ancestry로 확인하며 재게시하지 않는다', async t => {
  const fixture = await repository(t), originalGit = fixture.store.git.bind(fixture.store); let pushes = 0;
  fixture.store.git = async (args, ...rest) => {
    const result = await originalGit(args, ...rest);
    if (args[0] === 'push') { pushes++; throw new Error('local simulated response loss'); }
    return result;
  };
  const committed = await fixture.store.cas(fixture.Q, new Map([[evidencePath('3'), '{"observed":true}\n']]), 'lost acknowledgement');
  assert.equal(pushes, 1); assert.equal(await fixture.store.refresh(), committed);
  assert.equal(await fixture.store.read(committed, evidencePath('3')), '{"observed":true}\n');
  assert.equal(await fixture.store.git(['rev-list', '--count', `${fixture.Q}..${committed}`]), '1');
});

test('manifest trailing newline을 보존하며 미허용 파일·낡은 HEAD는 거부한다', async t => {
  const fixture = await repository(t);
  assert.equal(await fixture.store.read(fixture.V, 'dev/bundle.json'), fixture.baseline.bytes);
  await assert.rejects(fixture.store.cas(fixture.Q, new Map([['dev/credentials.json', 'must not publish']]), 'forbidden path'));
  assert.equal(await fixture.store.refresh(), fixture.Q);
  const head = await fixture.store.cas(fixture.Q, new Map([[evidencePath('4'), '{}\n']]), 'first append');
  await assert.rejects(fixture.store.cas(fixture.Q, new Map([[evidencePath('5'), '{}\n']]), 'stale owner'));
  assert.equal(await fixture.store.refresh(), head);
  await assert.rejects(fixture.store.read(head, '../credentials.json'));
  await assert.rejects(fixture.store.cas(head, new Map([['dev/generated/credentials.yaml', 'forbidden: data\n']]), 'unknown generated file'));
  await assert.rejects(fixture.store.cas(head, new Map([['dev/applications/unknown.yaml', '{}\n']]), 'unknown Application'));
});
