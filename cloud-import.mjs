import { VideoError } from './process-video.mjs';

const yandexShare = host => ['disk.yandex.ru', 'disk.yandex.com', 'disk.360.yandex.ru', 'yadi.sk'].includes(host);
const allowedHost = host => yandexShare(host) || host === 'dropbox.com' || host === 'www.dropbox.com' ||
  host === 'dl.dropboxusercontent.com' || host.endsWith('.dropboxusercontent.com') ||
  /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/.test(host);
const yandexDownload = host => /^[a-z0-9.-]+\.disk\.yandex\.(net|ru|com)$/.test(host) ||
  /^[a-z0-9-]+\.storage\.yandex\.net$/.test(host);

export function validateCloudUrl(value, allowYandexDownload = false) {
  let url;
  try { url = new URL(value); } catch { throw new VideoError('Введите полную ссылку HTTPS на файл.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(allowedHost(url.hostname) || (allowYandexDownload && yandexDownload(url.hostname))) ||
      value.length > 8192) {
    throw new VideoError(allowYandexDownload ?
      `Яндекс.Диск перенаправил скачивание на неподдерживаемый узел ${url.hostname}.` :
      'Поддерживаются ссылки HTTPS из Яндекс.Диска, Dropbox и публичного Vercel Blob.');
  }
  url.hash = '';
  if (url.hostname === 'dropbox.com' || url.hostname === 'www.dropbox.com') {
    url.searchParams.delete('raw');
    url.searchParams.set('dl', '1');
  }
  return url;
}

export async function downloadCloudVideo(link, maxBytes) {
  const original = validateCloudUrl(link);
  let url = original;
  let fileName = decodeURIComponent(original.pathname.split('/').pop() || '');
  const signal = AbortSignal.timeout(45_000);
  try {
    if (yandexShare(original.hostname)) {
      const endpoint = new URL('https://cloud-api.yandex.net/v1/disk/public/resources');
      endpoint.searchParams.set('public_key', original.href);
      endpoint.searchParams.set('fields', 'name,type,size');
      const metadataResponse = await fetch(endpoint, { signal, redirect: 'error' });
      if (!metadataResponse.ok) throw new VideoError('Яндекс.Диск не разрешает открыть файл. Проверьте ссылку и общий доступ.');
      const metadata = await metadataResponse.json();
      if (metadata.type !== 'file') throw new VideoError('Ссылка Яндекс.Диска ведёт на папку. Укажите ссылку на отдельное видео.');
      if (metadata.size > maxBytes) throw new VideoError('Размер видео превышает 10 МБ.');
      fileName = metadata.name;
      endpoint.pathname += '/download';
      endpoint.searchParams.delete('fields');
      const downloadResponse = await fetch(endpoint, { signal, redirect: 'error' });
      if (!downloadResponse.ok) throw new VideoError('Яндекс.Диск запретил скачивание. Проверьте доступ и лимит скачиваний.');
      const download = await downloadResponse.json();
      if (typeof download.href !== 'string') throw new VideoError('Яндекс.Диск не выдал ссылку на скачивание.');
      url = validateCloudUrl(download.href, true);
    }
    for (let hop = 0; hop < 6; hop++) {
      const response = await fetch(url, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new VideoError('Облако вернуло некорректное перенаправление.');
        url = validateCloudUrl(new URL(location, url).href, yandexShare(original.hostname));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new VideoError(response.status === 401 || response.status === 403 ?
          'Облако запретило скачивание. Проверьте общий доступ и срок действия ссылки.' :
          `Файл недоступен в облаке (HTTP ${response.status}). Возможно, ссылка истекла или файл удалён.`);
      }
      const name = fileName;
      const extension = name.match(/\.(mp4|webm)$/i)?.[0].toLowerCase();
      if (!extension) {
        await response.body?.cancel();
        throw new VideoError('Ссылка должна вести на файл с расширением MP4 или WebM.');
      }
      if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw new VideoError('Облако вернуло страницу вместо видео. Откройте доступ к скачиванию файла.');
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new VideoError(`Размер видео превышает ${Math.round(maxBytes / 1_000_000)} МБ.`);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new VideoError(`Размер видео превышает ${Math.round(maxBytes / 1_000_000)} МБ.`);
        chunks.push(chunk);
      }
      if (!size) throw new VideoError('Облако вернуло пустой файл.');
      return { bytes: Buffer.concat(chunks), name: name.replace(/[\\/\x00-\x1f]/g, '_').slice(-255), extension };
    }
    throw new VideoError('Облако вернуло слишком много перенаправлений.');
  } catch (error) {
    if (error instanceof VideoError) throw error;
    throw new VideoError('Не удалось скачать видео за 45 секунд. Проверьте ссылку и доступность облака.');
  }
}
