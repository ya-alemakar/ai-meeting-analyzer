import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

test('Загрузка 10 МБ и параллельный повторный импорт', async t => {
  const blobs = new Map();
  const pending = [];
  let calls = 0;
  let processedSize;
  t.mock.module('@vercel/blob', { namedExports: {
    async put(path, value, options) {
      if (blobs.has(path) && !options.allowOverwrite) throw new Error('Already exists');
      if (options.ifMatch && options.ifMatch !== 'etag') throw new Error('Precondition failed');
      blobs.set(path, Buffer.from(value));
    },
    async get(path) {
      const bytes = blobs.get(path);
      return bytes ? {
        stream: new Response(bytes).body, statusCode: 200,
        blob: { size: bytes.length, etag: 'etag' },
      } : null;
    },
    async del(paths) { for (const path of [paths].flat()) blobs.delete(path); },
    async list() { return { blobs: [], hasMore: false }; },
  } });
  t.mock.module('@vercel/functions', { namedExports: {
    waitUntil(promise) { pending.push(promise); },
  } });
  t.mock.module(new URL('../process-video.mjs', import.meta.url).href, { namedExports: {
    VideoError: class VideoError extends Error {},
    async processVideo(path) {
      calls++;
      processedSize = (await stat(path)).size;
      return { transcript: 'test', transcriptRu: 'тест', notes: { summary: [{ text: 'тест', quote: 'test' }] } };
    },
  } });
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'Content-Type': 'video/mp4' },
  }));
  const { POST } = await import('../api/meetings.js');
  const oldPassword = process.env.MEETING_APP_PASSWORD;
  process.env.MEETING_APP_PASSWORD = 'test-only-password';
  t.after(() => {
    if (oldPassword === undefined) delete process.env.MEETING_APP_PASSWORD;
    else process.env.MEETING_APP_PASSWORD = oldPassword;
  });
  const headers = {
    authorization: 'Basic ' + Buffer.from('meeting:test-only-password').toString('base64'),
    'X-Video-Name': 'test.mp4', 'X-Video-Size': '10000000',
  };
  const request = (query, body, extra = {}) => POST(new Request('https://app.test/api/meetings' + query, {
    method: 'POST', headers: { ...headers, ...extra }, body,
  }));
  const id = randomUUID();
  for (let index = 0; index < 3; index++) {
    const size = index < 2 ? 4_000_000 : 2_000_000;
    assert.equal((await request(`?upload=${id}&part=${index}`, new Uint8Array(size))).status, 200);
  }
  assert.equal((await request('?upload=' + id)).status, 202);
  await Promise.all(pending);
  assert.equal(processedSize, 10_000_000);
  assert.equal(calls, 1);
  assert.equal([...blobs.keys()].filter(path => path.startsWith('video-upload-parts/')).length, 0);
  assert.equal((await request('?upload=' + id)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await request('?upload=' + randomUUID(), undefined, { 'X-Video-Size': '10000001' })).status, 400);

  const options = { 'Content-Type': 'application/json', 'X-Cloud-Import': '1' };
  const body = JSON.stringify({ url: 'https://www.dropbox.com/s/id/test.mp4' });
  const responses = await Promise.all([request('?import=1', body, options), request('?import=1', body, options)]);
  const meetings = await Promise.all(responses.map(response => response.json()));
  await Promise.all(pending);
  assert.equal(meetings[0].id, meetings[1].id);
  assert.equal(calls, 2);
  assert.ok(meetings.some(meeting => meeting.duplicate));
});
