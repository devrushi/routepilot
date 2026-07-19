import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignedExportLinkService,
  createScheduledExportEmailWorker,
  createMockEmailProvider,
} from '../src/export-links.js';

function makeLinkService(nowRef, overrides = {}) {
  return createSignedExportLinkService({ secret: 'export-secret', now: () => nowRef.value, ...overrides });
}

test('a valid signed link is accepted and yields the driver/export it was issued for', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const links = makeLinkService(nowRef);
  const { token, expiresAt } = links.createLink('drv_1', 'exp_1');
  assert.ok(expiresAt > nowRef.value);

  const verified = links.verifyLink(token);
  assert.equal(verified.driverId, 'drv_1');
  assert.equal(verified.exportId, 'exp_1');
});

test('an expired link is rejected', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const links = makeLinkService(nowRef, { ttlSeconds: 60 });
  const { token } = links.createLink('drv_1', 'exp_1');
  nowRef.value += 61 * 1000;
  assert.throws(() => links.verifyLink(token), (e) => e.code === 'EXPORT_LINK_EXPIRED');
});

test('a tampered link is rejected', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const links = makeLinkService(nowRef);
  const { token } = links.createLink('drv_1', 'exp_1');
  const parts = token.split('.');
  const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`; // corrupt the payload segment
  assert.throws(() => links.verifyLink(tampered), (e) => e.code === 'EXPORT_LINK_INVALID');
});

test('a link signed with a different secret is rejected', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const links = makeLinkService(nowRef);
  const otherLinks = makeLinkService(nowRef, { secret: 'a-different-secret' });
  const { token } = otherLinks.createLink('drv_1', 'exp_1');
  assert.throws(() => links.verifyLink(token), (e) => e.code === 'EXPORT_LINK_INVALID');
});

test('createLink requires a driverId and exportId', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const links = makeLinkService(nowRef);
  assert.throws(() => links.createLink('', 'exp_1'), (e) => e.code === 'EXPORT_LINK_FIELD');
  assert.throws(() => links.createLink('drv_1', ''), (e) => e.code === 'EXPORT_LINK_FIELD');
});

test('runOnce emails each driver with a ready export a fresh signed download link', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const linkService = makeLinkService(nowRef);
  const emailProvider = createMockEmailProvider();
  const exportsByDriver = { drv_1: { exportId: 'exp_1' }, drv_2: null };

  const worker = createScheduledExportEmailWorker({
    linkService,
    emailProvider,
    listDriverIds: () => Object.keys(exportsByDriver),
    getLatestExport: (driverId) => exportsByDriver[driverId],
  });

  const results = await worker.runOnce();
  assert.equal(results.length, 1); // drv_2 has no export yet, skipped
  assert.equal(results[0].driverId, 'drv_1');
  assert.match(results[0].url, /\/exports\/download\?token=/);
  assert.equal(emailProvider.sent.length, 1);
  assert.equal(emailProvider.sent[0].email.driverId, 'drv_1');

  const { driverId, exportId } = linkService.verifyLink(results[0].sendResult.email.url.split('token=')[1]);
  assert.equal(driverId, 'drv_1');
  assert.equal(exportId, 'exp_1');
});

test('start/stop schedules and cancels sweeps without real timers', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const linkService = makeLinkService(nowRef);
  let scheduledFn = null;
  const worker = createScheduledExportEmailWorker({
    linkService,
    listDriverIds: () => [],
    getLatestExport: () => null,
    setInterval: (fn) => { scheduledFn = fn; return 'timer-handle'; },
    clearInterval: () => { scheduledFn = null; },
  });

  assert.equal(worker.isRunning(), false);
  worker.start({ intervalMs: 1000, immediate: false });
  assert.equal(worker.isRunning(), true);
  assert.ok(scheduledFn);
  assert.throws(() => worker.start({ intervalMs: 1000 }), (e) => e.code === 'EXPORT_LINK_STATE');

  worker.stop();
  assert.equal(worker.isRunning(), false);
});
