import { del, get, list, put } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processVideo, VideoError } from '../process-video.mjs';
import { downloadCloudVideo } from '../cloud-import.mjs';

const maxVideoBytes = 10_000_000;
const chunkBytes = 4_000_000;
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
  if (await read(pathFor('deleted', id))) return null;
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
    const results = await Promise.all(entries.slice(offset, offset + 12).map(([id]) => readMeeting(id)));
    for (const meeting of results) {
      if (!meeting) continue;
      const { id, name, createdAt, status } = meeting;
      meetings.push({ id, name, createdAt, status });
    }
  }
  return meetings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function analyze(meeting, extension, bytes, claim) {
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
      signal: AbortSignal.timeout(230_000),
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
  if (await read(pathFor('deleted', meeting.id))) return;
  await save('result', finished);
  // Очистка могла совпасть с записью результата фоновой задачи.
  if (await read(pathFor('deleted', meeting.id))) await del(pathFor('result', meeting.id));
  if (claim && finished.status === 'error') {
    const current = await get(claim, { access: 'private', useCache: false });
    if (current && (await new Response(current.stream).json()).id === meeting.id) {
      await del(claim, { ifMatch: current.blob.etag });
    }
  }
}

async function importVideo(request) {
  if (request.headers.get('x-cloud-import') !== '1') return json({ error: 'Некорректный запрос импорта.' }, 400);
  try {
    const { url } = await request.json();
    if (typeof url !== 'string') throw new VideoError('Введите ссылку на файл.');
    const { name, bytes, extension } = await downloadCloudVideo(url, maxVideoBytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const claim = `video-meeting-hashes/${digest}.json`;
    const meeting = {
      id: randomUUID(), name, createdAt: new Date().toISOString(),
      status: 'processing', source: 'cloud', contentHash: digest,
    };
    const existing = await get(claim, { access: 'private', useCache: false });
    let ifMatch;
    if (existing) {
      const owner = await new Response(existing.stream).json();
      const previous = await readMeeting(owner.id);
      const removed = await read(pathFor('deleted', owner.id));
      if (!removed && (previous?.status === 'ready' || (Date.now() - Date.parse(owner.createdAt) < 310_000))) {
        return json({ ...(previous || owner), duplicate: true });
      }
      ifMatch = existing.blob.etag;
    }
    try {
      await put(claim, JSON.stringify(meeting), {
        access: 'private', contentType: 'application/json',
        ...(ifMatch ? { allowOverwrite: true, ifMatch } : {}),
      });
    } catch (error) {
      // Атомарное создание или смена владельца исключает параллельный AI-анализ.
      const owner = await read(claim);
      if (!owner) throw error;
      return json({ ...((await readMeeting(owner.id)) || owner), duplicate: true });
    }
    try {
      await save('pending', meeting);
    } catch (error) {
      await del(claim);
      throw error;
    }
    waitUntil(analyze(meeting, extension, bytes, claim).catch(error => console.error('Import processing:', error.name)));
    return json(meeting, 202);
  } catch (error) {
    return json({ error: (error instanceof VideoError ? error.message : 'Не удалось импортировать запись.') +
      ' Можно скачать видео самостоятельно и выбрать «Выбрать видео».' }, 400);
  }
}

async function chunkedUpload(request, query, name, extension) {
  const id = query.get('upload');
  const size = Number(request.headers.get('x-video-size'));
  if (!idPattern.test(id || '') || !Number.isInteger(size) || size <= chunkBytes || size > maxVideoBytes) {
    return json({ error: 'Некорректные параметры загрузки. Максимум 10 МБ.' }, 400);
  }
  const count = Math.ceil(size / chunkBytes);
  const path = index => `video-upload-parts/${id}/${index}`;
  try {
    if (query.has('part')) {
      const index = Number(query.get('part'));
      if (!Number.isInteger(index) || index < 0 || index >= count) return json({ error: 'Некорректный номер части.' }, 400);
      const bytes = new Uint8Array(await request.arrayBuffer());
      const expected = Math.min(chunkBytes, size - index * chunkBytes);
      if (bytes.length !== expected) return json({ error: 'Размер части файла не совпадает.' }, 400);
      // Неизменяемые части: повторная отправка подтверждается только для тех же байтов.
      try {
        await put(path(index), bytes, { access: 'private', contentType: 'application/octet-stream' });
      } catch (error) {
        const existing = await get(path(index), { access: 'private', useCache: false });
        if (!existing) throw error;
        const old = Buffer.from(await new Response(existing.stream).arrayBuffer());
        if (!old.equals(Buffer.from(bytes))) return json({ error: 'Часть файла уже содержит другие данные. Начните загрузку снова.' }, 409);
      }
      return json({ received: index });
    }
    const previous = await readMeeting(id);
    if (previous) return json(previous);
    const pieces = [];
    for (let index = 0; index < count; index++) {
      const piece = await get(path(index), { access: 'private', useCache: false });
      if (!piece || piece.blob.size !== Math.min(chunkBytes, size - index * chunkBytes)) {
        return json({ error: 'Загрузка не завершена. Выберите файл снова.' }, 400);
      }
      pieces.push(Buffer.from(await new Response(piece.stream).arrayBuffer()));
    }
    const meeting = { id, name, createdAt: new Date().toISOString(), status: 'processing' };
    try {
      await put(path('started'), JSON.stringify(meeting), { access: 'private' });
    } catch {
      const existing = await readMeeting(id);
      return existing ? json(existing) : json({ error: 'Файл уже передаётся на обработку. Обновите историю.' }, 409);
    }
    try {
      await save('pending', meeting);
    } catch (error) {
      await del(path('started'));
      throw error;
    }
    waitUntil((async () => {
      try {
        await analyze(meeting, extension, Buffer.concat(pieces));
      } finally {
        await del([...Array.from({ length: count }, (_, index) => path(index)), path('started')]);
      }
    })().catch(error => console.error('Chunk processing:', error.name)));
    return json(meeting, 202);
  } catch (error) {
    console.error('Chunk upload:', error.name);
    return json({ error: 'Не удалось загрузить файл. Попробуйте выбрать его снова.' }, 503);
  }
}

export async function GET(request) {
  const query = new URL(request.url).searchParams;
  if (query.has('config')) return json({ maxVideoBytes, chunkBytes, cloudImport: true });
  const access = checkAccess(request);
  if (access) return access;
  if (query.has('login')) return Response.redirect(new URL('/', request.url), 303);
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

export async function DELETE(request) {
  const access = checkAccess(request);
  if (access) return access;
  if (request.headers.get('x-clear-history') !== '1') {
    return json({ error: 'Подтвердите очистку истории в приложении.' }, 400);
  }
  try {
    const meetings = await history();
    for (const meeting of meetings) {
      // Метка скрывает и результаты уже работающих фоновых задач.
      await put(pathFor('deleted', meeting.id), JSON.stringify({ id: meeting.id }), {
        access: 'private', contentType: 'application/json', allowOverwrite: true,
      });
      await del([pathFor('pending', meeting.id), pathFor('result', meeting.id)]);
    }
    return json({ cleared: meetings.length });
  } catch (error) {
    console.error('Clear history:', error.code ?? error.name);
    return json({ error: 'Не удалось полностью очистить историю. Повторите очистку.' }, 503);
  }
}

export async function POST(request) {
  const access = checkAccess(request);
  if (access) return access;
  const query = new URL(request.url).searchParams;
  if (query.has('import')) return importVideo(request);
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
  if (query.has('upload')) return chunkedUpload(request, query, name, extension);
  if (Number(request.headers.get('content-length')) > maxVideoBytes) {
    return json({ error: 'Выберите непустое видео размером до 10 МБ.' }, 413);
  }
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > maxVideoBytes) {
      return json({ error: 'Выберите непустое видео размером до 10 МБ.' }, 413);
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
