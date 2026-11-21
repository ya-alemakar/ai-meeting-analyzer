import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { MAX_VIDEO_BYTES, processVideo, VideoError } from './process-video.mjs';

const dataDir = process.env.MEETING_DATA_DIR || join(import.meta.dirname, 'data');
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'meetings.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT NOT NULL
  );
`);
db.prepare("UPDATE meetings SET status = 'error', result = json_set(result, '$.error', ?) WHERE status = 'processing'")
  .run('Обработка прервалась при остановке сервера. Загрузите видео снова.');

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
]);
const list = db.prepare('SELECT id, name, created_at AS createdAt, status FROM meetings ORDER BY created_at DESC, rowid DESC');
const find = db.prepare('SELECT id, name, created_at AS createdAt, status, result FROM meetings WHERE id = ?');
const insert = db.prepare("INSERT INTO meetings VALUES (?, ?, ?, 'processing', '{}')");
const update = db.prepare('UPDATE meetings SET status = ?, result = ? WHERE id = ?');
let activeUploads = 0;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function receive(req, res) {
  let name;
  try {
    name = decodeURIComponent(req.headers['x-video-name'] ?? '').trim();
  } catch {
    return send(res, 400, { error: 'Не удалось прочитать имя файла.' });
  }
  const extension = name.match(/\.(mp4|webm)$/i)?.[0].toLowerCase();
  if (!extension || name.length > 255 || /[\\/\x00-\x1f]/.test(name)) {
    return send(res, 400, { error: 'Выберите файл в формате MP4 или WebM.' });
  }
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_VIDEO_BYTES) {
    return send(res, 413, { error: 'Выберите непустое видео размером до 200 МБ.' });
  }
  if (activeUploads >= 2) {
    return send(res, 429, { error: 'Сейчас обрабатываются две записи. Дождитесь завершения одной из них.' });
  }

  activeUploads++;
  let temp;
  let id;
  let partial = {};
  try {
    temp = await mkdtemp(join(tmpdir(), 'meeting-video-'));
    const videoPath = join(temp, `upload${extension}`);
    await pipeline(req, createWriteStream(videoPath));
    const createdAt = new Date().toISOString();
    const meetingId = randomUUID();
    insert.run(meetingId, name, createdAt);
    id = meetingId;
    send(res, 202, { id, name, createdAt, status: 'processing' });
    const result = await processVideo(videoPath, {
      onTranscript: value => {
        partial = value;
        update.run('processing', JSON.stringify(value), id);
      },
    });
    update.run('ready', JSON.stringify(result), id);
  } catch (error) {
    const message = error instanceof VideoError ? error.message : 'Не удалось обработать запись. Попробуйте загрузить её снова.';
    if (!(error instanceof VideoError)) console.error('Ошибка обработки:', error.code ?? error.name);
    if (id) update.run('error', JSON.stringify({ ...partial, error: message }), id);
    if (!res.headersSent && !res.destroyed) send(res, 500, { error: message });
  } finally {
    activeUploads--;
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  try {
    const port = server.address().port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
      return send(res, 403, { error: 'Откройте приложение через локальный адрес, указанный при запуске.' });
    }
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path);
      const body = await readFile(join(import.meta.dirname, 'public', file));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(body);
    }
    if (path === '/api/meetings') {
      if (req.method === 'DELETE') {
        if (req.headers['x-clear-history'] !== '1') {
          return send(res, 400, { error: 'Подтвердите очистку истории в приложении.' });
        }
        const cleared = db.prepare('DELETE FROM meetings').run().changes;
        return send(res, 200, { cleared });
      }
      if (req.method === 'GET' && url.searchParams.has('config')) {
        return send(res, 200, { maxVideoBytes: MAX_VIDEO_BYTES });
      }
      if (req.method === 'GET') return send(res, 200, list.all());
      if (req.method === 'POST') return await receive(req, res);
    }
    const id = path.match(/^\/api\/meetings\/([a-f0-9-]{36})$/)?.[1];
    if (req.method === 'GET' && id) {
      const row = find.get(id);
      if (row) {
        const { result, ...meeting } = row;
        return send(res, 200, { ...meeting, ...JSON.parse(result) });
      }
    }
    send(res, 404, { error: 'Страница или встреча не найдена.' });
  } catch (error) {
    console.error('Ошибка сервера:', error.code ?? error.name);
    if (!res.headersSent && !res.destroyed) send(res, 500, { error: 'Внутренняя ошибка сервера.' });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '127.0.0.1', () => {
  console.log(`AI-анализатор видеовстреч: http://127.0.0.1:${server.address().port}`);
});
