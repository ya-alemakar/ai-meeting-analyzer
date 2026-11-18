import { get, list, put } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processVideo, VideoError } from '../process-video.mjs';

const maxVideoBytes = 4_000_000;
const prefix = 'video-meetings/v1/';
const idPattern = /^[a-f0-9-]{36}$/;
const json = (data, status = 200, headers = {}) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', ...headers },
});
const pathFor = (kind, id) => `${prefix}${id}/${kind}.json`;

function checkAccess(request) {
  const password = process.env.MEETING_APP_PASSWORD;
  if (!password) return json({ error: 'На сервере не задан пароль приложения.' }, 503);
  const expected = `Basic ${Buffer.from(`meeting:${password}`).toString('base64')}`;
  const hash = value => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(hash(request.headers.get('authorization') || ''), hash(expected))) {
    return json({ error: 'Войдите, чтобы открыть историю.' }, 401, {
      'WWW-Authenticate': 'Basic realm="Video Meetings", charset="UTF-8"',
    });
  }
}

async function save(kind, meeting) {
  await put(pathFor(kind, meeting.id), JSON.stringify(meeting), {
    access: 'private', contentType: 'application/json',
  });
}

async function read(path) {
  const blob = await get(path, { access: 'private', useCache: false });
  return blob ? new Response(blob.stream).json() : null;
}

async function readMeeting(id) {
  const [finished, pending] = await Promise.all([
    read(pathFor('result', id)), read(pathFor('pending', id)),
  ]);
  if (finished || !pending) return finished;
  if (Date.now() - Date.parse(pending.createdAt) > 310_000) {
    return { ...pending, status: 'error', error: 'Обработка прервалась по тайм-ауту. Загрузите файл снова.' };
  }
  return pending;
}

async function history() {
  const ids = new Map();
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    for (const { pathname } of page.blobs) {
      const [id, file] = pathname.slice(prefix.length).split('/');
      if (!idPattern.test(id)) continue;
      if (file === 'result.json' || !ids.has(id)) ids.set(id, file);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const entries = [...ids];
  const meetings = [];
  for (let offset = 0; offset < entries.length; offset += 12) {
    const results = await Promise.all(entries.slice(offset, offset + 12).map(([id, file]) => (
      file === 'result.json' ? read(pathFor('result', id)) : readMeeting(id)
    )));
    for (const meeting of results) {
      if (!meeting) continue;
      const { id, name, createdAt, status } = meeting;
      meetings.push({ id, name, createdAt, status });
    }
  }
  return meetings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function analyze(meeting, extension, bytes) {
  let temp;
  let partial = {};
  let finished;
  try {
    temp = await mkdtemp(join(tmpdir(), 'meeting-cloud-'));
    const path = join(temp, `upload${extension}`);
    await writeFile(path, bytes);
    const result = await processVideo(path, {
      ffmpeg: fileURLToPath(new URL('../node_modules/@ffmpeg-installer/linux-x64/ffmpeg', import.meta.url)),
      ffprobe: fileURLToPath(new URL('../node_modules/@ffprobe-installer/linux-x64/ffprobe', import.meta.url)),
      signal: AbortSignal.timeout(255_000),
      onTranscript: value => { partial = value; },
    });
    finished = { ...meeting, ...result, status: 'ready' };
  } catch (error) {
    if (!(error instanceof VideoError)) console.error('Cloud processing:', error.code ?? error.name);
    finished = {
      ...meeting, ...partial, status: 'error',
      error: error instanceof VideoError ? error.message : 'Не удалось обработать запись. Загрузите файл снова.',
    };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(error => console.error('Cleanup:', error.code));
  }
  await save('result', finished);
}

export async function GET(request) {
  const access = checkAccess(request);
  if (access) return access;
  const query = new URL(request.url).searchParams;
  if (query.has('login')) return Response.redirect(new URL('/', request.url), 303);
  if (query.has('config')) return json({ maxVideoBytes });
  try {
    const id = query.get('id');
    if (id === null) return json(await history());
    const meeting = idPattern.test(id) && await readMeeting(id);
    return meeting ? json(meeting) : json({ error: 'Встреча не найдена.' }, 404);
  } catch (error) {
    console.error('Cloud read:', error.code ?? error.name);
    return json({ error: 'Не удалось открыть облачную историю.' }, 503);
  }
}

export async function POST(request) {
  const access = checkAccess(request);
  if (access) return access;
  // A cross-origin form cannot supply the required custom header.
  let name;
  try {
    name = decodeURIComponent(request.headers.get('x-video-name') ?? '').trim();
  } catch {
    return json({ error: 'Не удалось прочитать имя файла.' }, 400);
  }
  const extension = name.match(/\.(mp4|webm)$/i)?.[0].toLowerCase();
  if (!extension || name.length > 255 || /[\\/\x00-\x1f]/.test(name)) {
    return json({ error: 'Выберите файл в формате MP4 или WebM.' }, 400);
  }
  if (Number(request.headers.get('content-length')) > maxVideoBytes) {
    return json({ error: 'Выберите непустое видео размером до 4 МБ.' }, 413);
  }
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > maxVideoBytes) {
      return json({ error: 'Выберите непустое видео размером до 4 МБ.' }, 413);
    }
    const meeting = { id: randomUUID(), name, createdAt: new Date().toISOString(), status: 'processing' };
    await save('pending', meeting);
    waitUntil(analyze(meeting, extension, bytes).catch(error => console.error('Cloud write:', error.code ?? error.name)));
    return json(meeting, 202);
  } catch (error) {
    console.error('Cloud upload:', error.code ?? error.name);
    return json({ error: 'Не удалось сохранить запись в облаке.' }, 503);
  }
}
