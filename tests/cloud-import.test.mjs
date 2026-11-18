import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadCloudVideo, validateCloudUrl } from '../cloud-import.mjs';

test('Яндекс.Диск получает имя и адрес скачивания через публичный API', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(new URL(url));
    if (requests.length === 1) return Response.json({ name: 'Встреча.webm', type: 'file', size: 3 });
    if (requests.length === 2) return Response.json({ href: 'https://downloader.disk.yandex.ru/disk/token' });
    if (requests.length === 3) return new Response(null, {
      status: 302, headers: { Location: 'https://s123.storage.yandex.net/file' },
    });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/webm' } });
  });
  const file = await downloadCloudVideo('https://disk.yandex.ru/i/example', 10_000_000);
  assert.equal(file.name, 'Встреча.webm');
  assert.equal(file.extension, '.webm');
  assert.equal(file.bytes.length, 3);
  assert.equal(requests[0].origin, 'https://cloud-api.yandex.net');
  assert.equal(requests[0].searchParams.get('public_key'), 'https://disk.yandex.ru/i/example');
  assert.equal(requests[1].pathname, '/v1/disk/public/resources/download');
  assert.equal(requests[3].hostname, 's123.storage.yandex.net');
  t.mock.restoreAll();
});

test('Папка и превышение лимита отклоняются до скачивания', async t => {
  for (const metadata of [
    { name: 'folder', type: 'dir' },
    { name: 'large.mp4', type: 'file', size: 10_000_001 },
  ]) {
    const stub = t.mock.method(globalThis, 'fetch', async () => Response.json(metadata));
    await assert.rejects(() => downloadCloudVideo('https://yadi.sk/d/example', 10_000_000));
    assert.equal(stub.mock.callCount(), 1);
    t.mock.restoreAll();
  }
});

test('Поток ограничен размером даже без Content-Length', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(11)));
  await assert.rejects(() => downloadCloudVideo('https://www.dropbox.com/s/id/test.mp4', 10), /Размер/);
  t.mock.restoreAll();
});

test('Внутренние адреса, подмена домена и небезопасные переходы запрещены', async t => {
  for (const url of [
    'http://disk.yandex.ru/i/test', 'https://127.0.0.1/a.mp4',
    'https://disk.yandex.ru.evil.test/a.mp4', 'https://user:pass@disk.yandex.ru/i/test',
    'https://downloader.disk.yandex.ru/disk/private',
  ]) assert.throws(() => validateCloudUrl(url));
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302, headers: { Location: 'https://127.0.0.1/private.mp4' },
  }));
  await assert.rejects(() => downloadCloudVideo('https://www.dropbox.com/s/id/test.mp4', 10));
  t.mock.restoreAll();
});
