const input = document.querySelector('#video');
const choose = document.querySelector('#choose');
const dropZone = document.querySelector('#drop-zone');
const feedback = document.querySelector('#upload-status');
const history = document.querySelector('#history');
const historyStatus = document.querySelector('#history-status');
const count = document.querySelector('#count');
const result = document.querySelector('#result');
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const statuses = { processing: 'Обрабатывается', ready: 'Готово', error: 'Ошибка' };
const sections = {
  summary: ['Краткое содержание', 'Основные темы не выделены.'],
  decisions: ['Решения', 'В расшифровке нет явно принятых решений.'],
  tasks: ['Задачи', 'В расшифровке нет явно согласованных задач.'],
  questions: ['Открытые вопросы', 'В расшифровке нет явно открытых вопросов.'],
};

let meetings = [];
let selectedId = new URLSearchParams(location.search).get('meeting');
let displayed = '';
let pollTimer;
let refreshId = 0;
let detailId = 0;
let maxVideoBytes = 200 * 1024 * 1024;
let limitLabel = '200 МБ';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

for (const height of [6, 12, 8, 17, 25, 12, 29, 44, 27, 53, 68, 28, 50, 82, 108, 63, 94, 119, 72, 104, 62, 40, 70, 43, 30, 26, 38, 19, 12, 15, 7]) {
  const bar = element('i');
  bar.style.height = `${height}px`;
  document.querySelector('.wave').append(bar);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}

function badge(status) {
  return element('span', `badge ${status}`, statuses[status]);
}

function updateSelection() {
  for (const row of history.querySelectorAll('button')) {
    row.setAttribute('aria-current', String(row.dataset.id === selectedId));
  }
}

function renderHistory() {
  count.textContent = meetings.length;
  count.hidden = meetings.length === 0;
  historyStatus.textContent = 'Загруженные записи появятся здесь.';
  historyStatus.hidden = meetings.length > 0;
  const focusedId = history.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const rows = meetings.map(meeting => {
    const item = element('li');
    const row = element('button', 'meeting-row');
    row.type = 'button';
    row.dataset.id = meeting.id;
    const meta = element('span', 'meeting-meta');
    const time = element('time', '', dateFormat.format(new Date(meeting.createdAt)));
    time.dateTime = meeting.createdAt;
    meta.append(time, badge(meeting.status));
    row.append(element('span', 'meeting-name', meeting.name), meta);
    row.addEventListener('click', () => select(meeting));
    item.append(row);
    return item;
  });
  history.replaceChildren(...rows);
  updateSelection();
  if (focusedId) [...history.querySelectorAll('button')].find(row => row.dataset.id === focusedId)?.focus();
}

function transcript(label, text) {
  const details = element('details', 'transcript');
  details.append(element('summary', '', label), element('p', '', text));
  return details;
}

function renderMeeting(meeting) {
  const value = JSON.stringify(meeting);
  if (value === displayed) return;
  displayed = value;

  const top = element('div', 'result-top');
  top.append(badge(meeting.status), element('h2', '', meeting.name));
  const info = dateFormat.format(new Date(meeting.createdAt));
  const duration = meeting.duration && ` · ${Math.floor(meeting.duration / 60)} мин ${Math.floor(meeting.duration % 60)} с`;
  top.append(element('p', 'muted', info + (duration || '')));
  result.replaceChildren(top);

  if (meeting.status !== 'ready') {
    const message = element('p', `result-message ${meeting.status}`, meeting.error || (
      meeting.transcript ? 'Речь распознана. Готовим перевод и конспект.' : 'Извлекаем аудио и распознаём речь.'
    ));
    message.setAttribute('role', 'status');
    result.append(message);
  }

  if (meeting.notes) {
    const notes = element('div', 'notes');
    for (const [key, [label, empty]] of Object.entries(sections)) {
      const section = element('section', 'note-section');
      section.append(element('h3', '', label));
      const entries = meeting.notes[key];
      if (entries.length === 0) {
        section.append(element('p', 'muted', empty));
      } else {
        const list = element('ul');
        for (const { text, quote } of entries) {
          const item = element('li', '', text);
          const source = element('details', 'evidence');
          source.append(element('summary', '', 'Фрагмент расшифровки'), element('blockquote', '', quote));
          item.append(source);
          list.append(item);
        }
        section.append(list);
      }
      notes.append(section);
    }
    result.append(notes);
  }

  if (meeting.transcriptRu) {
    const russian = transcript('Расшифровка на русском', meeting.transcriptRu);
    russian.open = true;
    if (meeting.transcript !== meeting.transcriptRu) {
      russian.append(transcript('Оригинальная расшифровка', meeting.transcript));
    }
    result.append(russian);
  } else if (meeting.transcript) {
    const original = transcript('Оригинальная расшифровка', meeting.transcript);
    original.open = true;
    result.append(original);
  }
}

async function loadMeeting(id) {
  const requestId = ++detailId;
  try {
    const meeting = await request(`/api/meetings/${id}`);
    if (requestId === detailId && id === selectedId) renderMeeting(meeting);
  } catch {
    if (requestId === detailId && id === selectedId) {
      displayed = '';
      result.replaceChildren(element('p', 'result-message error', 'Не удалось открыть встречу.'));
    }
  }
}

function select(meeting) {
  selectedId = meeting.id;
  const url = new URL(location.href);
  url.searchParams.set('meeting', selectedId);
  window.history.replaceState(null, '', url);
  updateSelection();
  if (meeting.status === 'processing') renderMeeting(meeting);
  else {
    displayed = '';
    const loading = element('p', 'result-message', 'Открываем встречу…');
    loading.setAttribute('role', 'status');
    result.replaceChildren(loading);
  }
  void loadMeeting(meeting.id);
}

async function refresh() {
  clearTimeout(pollTimer);
  const requestId = ++refreshId;
  let retry = false;
  try {
    const items = await request('/api/meetings');
    if (requestId !== refreshId) return;
    const changed = JSON.stringify(meetings) !== JSON.stringify(items);
    meetings = items;
    if (changed || !historyStatus.hidden) renderHistory();
    const selected = meetings.find(meeting => meeting.id === selectedId);
    if (selected) {
      await loadMeeting(selected.id);
    } else if (meetings.length > 0) {
      select(meetings[0]);
    } else {
      displayed = '';
      result.replaceChildren(document.querySelector('#empty-result').content.cloneNode(true));
    }
    retry = meetings.some(meeting => meeting.status === 'processing');
  } catch (error) {
    if (requestId !== refreshId) return;
    historyStatus.hidden = false;
    if (error.status === 401) {
      const login = element('a', '', 'Войти в приложение');
      login.href = '/api/meetings?login=1';
      historyStatus.replaceChildren(login);
    } else {
      historyStatus.textContent = error.message || 'Связь с сервером потеряна. Повторяем запрос…';
      retry = true;
    }
  }
  if (retry && requestId === refreshId) pollTimer = setTimeout(refresh, 1500);
}

function setFeedback(message = '', isError = false) {
  feedback.hidden = !message;
  feedback.textContent = message;
  feedback.classList.toggle('error', isError);
}

async function upload(file) {
  if (!file || choose.disabled) return;
  if (!/\.(mp4|webm)$/i.test(file.name)) return setFeedback('Выберите видео MP4 или WebM.', true);
  if (!file.size || file.size > maxVideoBytes) return setFeedback(`Выберите непустой файл размером до ${limitLabel}.`, true);

  choose.disabled = true;
  setFeedback('Загружаем видео…');
  try {
    const meeting = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Video-Name': encodeURIComponent(file.name) },
      body: file,
    });
    select(meeting);
    setFeedback();
    await refresh();
  } catch (error) {
    setFeedback(error instanceof TypeError ? 'Сервер недоступен. Попробуйте снова.' : error.message, true);
  } finally {
    choose.disabled = false;
  }
}

choose.addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const file = input.files[0];
  input.value = '';
  void upload(file);
});
for (const event of ['dragenter', 'dragover']) {
  dropZone.addEventListener(event, drag => {
    drag.preventDefault();
    dropZone.classList.add('dragging');
  });
}
dropZone.addEventListener('dragleave', drag => {
  if (!dropZone.contains(drag.relatedTarget)) dropZone.classList.remove('dragging');
});
dropZone.addEventListener('drop', drag => {
  drag.preventDefault();
  dropZone.classList.remove('dragging');
  if (drag.dataTransfer.files.length > 1) return setFeedback('Перетащите одно видео за раз.', true);
  void upload(drag.dataTransfer.files[0]);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
result.append(document.querySelector('#empty-result').content.cloneNode(true));
void request('/api/meetings?config=1').then(config => {
  if (config.maxVideoBytes === 4_000_000) {
    maxVideoBytes = config.maxVideoBytes;
    limitLabel = '4 МБ';
    document.querySelector('.file-limits').textContent = `MP4 или WebM · 2–5 минут · до ${limitLabel}`;
  }
}).catch(() => {});
void refresh();
