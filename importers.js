const MAX_IMPORT_TASKS = 2000;

const asText = value => String(value ?? '').trim();
const headerKey = value => asText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(cell); cell = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else cell += character;
  }
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('This CSV needs a header row and at least one task.');

  const headers = rows.shift().map(headerKey);
  return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

function firstValue(row, fields) {
  return fields.map(field => row[field]).find(value => asText(value));
}

function parseDate(value) {
  const text = asText(value);
  if (!text) return null;
  const iso = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseMinutes(value) {
  const text = asText(value).toLowerCase();
  if (!text) return 30;
  const hours = text.match(/(\d+(?:\.\d+)?)\s*h/);
  const minutes = text.match(/(\d+)\s*m/);
  if (hours || minutes) return Math.min(10080, Math.max(0, Math.round((Number(hours?.[1] || 0) * 60) + Number(minutes?.[1] || 0))));
  const numeric = Number(text);
  return Number.isFinite(numeric) ? Math.min(10080, Math.max(0, Math.round(numeric))) : 30;
}

function normalisePriority(value) {
  const text = asText(value).toLowerCase();
  if (['p1', 'urgent', 'highest', 'critical'].includes(text)) return 'urgent';
  if (['p2', 'high', 'important'].includes(text)) return 'high';
  if (['p4', 'low', 'lowest'].includes(text)) return 'low';
  return 'medium';
}

function normaliseStatus(value, completedAt) {
  const text = asText(value).toLowerCase();
  if (completedAt || ['done', 'complete', 'completed', 'closed'].includes(text)) return 'done';
  if (['in progress', 'in_progress', 'doing', 'started'].includes(text)) return 'progress';
  return 'todo';
}

function normaliseRows(rows, source) {
  const tasks = rows.map(row => {
    const title = asText(firstValue(row, ['title', 'task_name', 'task', 'name', 'content', 'subject'])).slice(0, 500);
    const completedAt = firstValue(row, ['completed_at', 'completed_date', 'completion_date']);
    const completedDate = completedAt ? new Date(completedAt) : null;
    return {
      title,
      notes: asText(firstValue(row, ['notes', 'note', 'description', 'content', 'details', 'comments'])),
      project: asText(firstValue(row, ['project', 'project_name', 'channel', 'channel_name', 'list', 'list_name', 'folder'])) || 'Inbox',
      dueDate: parseDate(firstValue(row, ['due_date', 'due', 'deadline', 'date'])),
      plannedMinutes: parseMinutes(firstValue(row, ['planned_minutes', 'planned_time', 'duration', 'estimate', 'estimated_time'])),
      priority: normalisePriority(firstValue(row, ['priority'])),
      status: normaliseStatus(firstValue(row, ['status', 'completed']), completedAt),
      completedAt: completedDate && !Number.isNaN(completedDate.getTime()) ? completedDate.toISOString() : null,
      source
    };
  }).filter(task => task.title);
  if (!tasks.length) throw new Error('We could not find a task title column in this file.');
  if (tasks.length > MAX_IMPORT_TASKS) throw new Error(`This file has more than ${MAX_IMPORT_TASKS} tasks. Split it into smaller imports and try again.`);
  return tasks;
}

function jsonRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.tasks)) return value.tasks;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  throw new Error('This JSON export does not contain a task list.');
}

export async function parseImportFile(file, source) {
  const text = await file.text();
  if (!text.trim()) throw new Error('This file is empty.');
  const isJson = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
  const rows = isJson ? jsonRows(JSON.parse(text)) : parseCsv(text);
  return normaliseRows(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [headerKey(key), value]))), source);
}
