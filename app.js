import { connectGoogleCalendar, initAuth, signInWithGoogle, signInWithMagicLink, getAuthState } from './supabase.js';
import { commitDayPlan, createSavedFilter, createTask, deleteSavedFilter, loadDailyPlan, loadWorkspace, persistLocalTasks, searchWorkspaceTasks, subscribeToWorkspace, updateTask } from './data.js';
import { loadCalendarEvents, saveGoogleGrant, startCalendarSync, syncGoogleCalendar } from './calendar.js';
import { renderDitherAvatar } from './dither-avatar.js';

const initialTasks = [
  { id: 1, title: 'Homepage visual QA', project: 'Studio relaunch', date: 'today', time: '9:00', duration: '45m', status: 'progress', priority: 'high', color: 'coral', notes: 'Review spacing and mobile states' },
  { id: 2, title: 'Homepage critique', project: 'Studio relaunch', date: 'today', time: '10:30', duration: '45m', status: 'progress', priority: 'high', color: 'coral', meeting: true },
  { id: 3, title: 'Write launch email draft', project: 'Studio relaunch', date: 'today', time: '12:00', duration: '60m', status: 'todo', priority: 'medium', color: 'coral' },
  { id: 4, title: 'Book dentist appointment', project: 'Personal', date: 'today', time: '2:00', duration: '15m', status: 'todo', priority: 'low', color: 'blue' },
  { id: 5, title: 'Finalize type scale', project: 'Studio relaunch', date: 'tomorrow', time: '9:30', duration: '45m', status: 'todo', priority: 'medium', color: 'coral' },
  { id: 6, title: 'Order entryway bench', project: 'Home', date: 'tomorrow', time: '4:00', duration: '20m', status: 'todo', priority: 'low', color: 'sage' },
  { id: 7, title: 'Prepare client handoff', project: 'Studio relaunch', date: 'friday', time: '11:00', duration: '90m', status: 'todo', priority: 'high', color: 'coral' },
  { id: 8, title: 'Weekly review', project: 'Personal', date: 'friday', time: '3:30', duration: '30m', status: 'todo', priority: 'medium', color: 'blue' },
  { id: 9, title: 'Mobile navigation prototype', project: 'Studio relaunch', date: 'someday', time: '', duration: '60m', status: 'progress', priority: 'medium', color: 'coral' },
  { id: 10, title: 'Archive old project files', project: 'Studio relaunch', date: 'someday', time: '', duration: '30m', status: 'done', priority: 'low', color: 'coral' },
  { id: 11, title: 'Fix loose kitchen handle', project: 'Home', date: 'someday', time: '', duration: '15m', status: 'done', priority: 'low', color: 'sage' },
  { id: 12, title: 'Plan winter weekend', project: 'Personal', date: 'someday', time: '', duration: '30m', status: 'todo', priority: 'low', color: 'blue' }
];

let tasks = JSON.parse(localStorage.getItem('maki-tasks') || 'null') || initialTasks;
let projects = [
  { id: 'local-0', name: 'Studio relaunch', color: 'coral' },
  { id: 'local-1', name: 'Home', color: 'sage' },
  { id: 'local-2', name: 'Personal', color: 'blue' }
];
let savedFilters = [];
let persistenceMode = 'local';
let hydratedUserId = null;
let stopWorkspaceSubscription = () => {};
let activeProject = 'Studio relaunch';
let currentFilter = 'all';
let activeFilters = { query: '', project: 'all', priority: 'all', status: 'all', due: 'all' };
let remoteSearchResults = null;
let weekOffset = 0;
let calendarEvents = [];
let calendarSyncUserId = null;
let planningDate = null;
let planningSelected = new Set();
let planningDurations = new Map();
let planningSchedule = [];
let focusSeconds = 25 * 60;
let focusInterval = null;
let focusRunning = true;

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const save = () => persistLocalTasks(tasks);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const localDateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const minutesLabel = minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
const timeLabel = date => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const clockMinutes = value => {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const [hours, minutes] = String(value).split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 23) * 60 + (Number.isFinite(minutes) ? minutes : 59);
};

const colorForProject = project => ({ 'Studio relaunch': 'coral', Home: 'sage', Personal: 'blue' }[project] || 'blue');
const readableDate = date => ({ overdue: 'Overdue', today: 'Today', tomorrow: 'Tomorrow', friday: 'Friday', upcoming: 'Upcoming', someday: 'No date' }[date] || date);

function showToast(message) {
  $('#toastText').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $('#toast').classList.remove('show'), 2200);
}

function renderProfileAvatar(user, fullName) {
  const avatar = $('.avatar');
  const image = $('img', avatar);
  const canvas = $('canvas', avatar);
  const metadata = user.user_metadata || {};
  const profileImage = metadata.avatar_url || metadata.picture || '';
  const seed = user.id || user.email || fullName;
  avatar.setAttribute('aria-label', `${fullName} avatar`);

  const showGeneratedAvatar = () => {
    image.hidden = true;
    canvas.hidden = false;
    renderDitherAvatar(canvas, seed);
  };

  image.onload = () => {
    canvas.hidden = true;
    image.hidden = false;
  };
  image.onerror = showGeneratedAvatar;
  if (profileImage) {
    showGeneratedAvatar();
    image.src = profileImage;
  } else {
    image.removeAttribute('src');
    showGeneratedAvatar();
  }
}

function updateCounts() {
  const open = tasks.filter(task => task.status !== 'done');
  $('#allCount').textContent = open.length;
  $('#todayCount').textContent = open.filter(task => task.date === 'today').length;
  $('#agendaCount').textContent = `${open.filter(task => task.date === 'today').length} tasks`;
}

function taskCheck(task) {
  return `<button class="task-check ${task.status === 'done' ? 'checked' : ''}" data-complete="${task.id}" aria-label="${task.status === 'done' ? 'Mark incomplete' : 'Complete task'}">${task.status === 'done' ? '✓' : ''}</button>`;
}

function renderTimeline() {
  const todayTasks = tasks.filter(task => task.date === 'today').sort((a, b) => {
    const aTime = a.scheduledAt ? new Date(a.scheduledAt).getHours() * 60 + new Date(a.scheduledAt).getMinutes() : clockMinutes(a.time);
    const bTime = b.scheduledAt ? new Date(b.scheduledAt).getHours() * 60 + new Date(b.scheduledAt).getMinutes() : clockMinutes(b.time);
    return aTime - bTime;
  });
  $('#timeline').innerHTML = todayTasks.map(task => `<div class="timeline-row">
      <span class="time-label">${escapeHtml(task.time || 'Anytime')}</span>
      <div class="timeline-content"><article class="timeline-task ${task.color}-line ${task.status === 'done' ? 'completed' : ''}">
        ${taskCheck(task)}
        <div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.project)}${task.meeting ? ' · Google Meet' : ''}</p></div>
        <span class="task-duration">${escapeHtml(task.duration)}</span>
      </article></div>
    </div>`).join('') + `<div class="timeline-row"><span class="time-label">+</span><div class="timeline-content"><button class="empty-slot" data-open-task>Schedule something here</button></div></div>`;
}

function renderBoard() {
  const columns = [
    { id: 'todo', label: 'To do', dot: '' },
    { id: 'progress', label: 'In progress', dot: 'progress' },
    { id: 'done', label: 'Done', dot: 'done' }
  ];
  const projectTasks = tasks.filter(task => task.project === activeProject);
  $('#kanbanBoard').innerHTML = columns.map(column => {
    const items = projectTasks.filter(task => task.status === column.id);
    return `<section class="kanban-column">
      <header class="column-header"><i class="status-dot ${column.dot}"></i><strong>${column.label}</strong><span>${items.length}</span><button aria-label="Column options">···</button></header>
      <div class="kanban-cards" data-status="${column.id}">${items.map(task => `<article class="kanban-card" draggable="true" data-id="${task.id}">
        <span class="card-label">${task.project}</span><h3>${task.title}</h3>
        <div class="card-meta"><span>${readableDate(task.date)}</span><span>·</span><span>${task.duration}</span>${task.priority === 'high' ? '<span class="priority">⚑ High</span>' : ''}</div>
      </article>`).join('')}</div>
      <button class="add-card" data-open-task>+ Add task</button>
    </section>`;
  }).join('');
  bindDragAndDrop();
}

function taskMatchesFilters(task) {
  const query = activeFilters.query.trim().toLocaleLowerCase();
  const selectedProject = projects.find(project => project.id === activeFilters.project);
  const matchesTab = currentFilter === 'all' || task.date === currentFilter || (currentFilter === 'upcoming' && ['tomorrow', 'upcoming', 'friday'].includes(task.date));
  const matchesQuery = !query || [task.title, task.notes, task.project].some(value => value?.toLocaleLowerCase().includes(query));
  const matchesProject = activeFilters.project === 'all' || task.projectId === activeFilters.project || task.project === activeFilters.project || task.project === selectedProject?.name;
  const matchesPriority = activeFilters.priority === 'all' || task.priority === activeFilters.priority || (activeFilters.priority === 'important' && ['urgent', 'high'].includes(task.priority));
  const matchesStatus = activeFilters.status === 'all' || (activeFilters.status === 'open' ? !['done', 'archived'].includes(task.status) : task.status === activeFilters.status);
  const matchesDue = activeFilters.due === 'all' || (activeFilters.due === 'unscheduled' ? !task.dueDate && task.date === 'someday' : activeFilters.due === 'upcoming' ? ['tomorrow', 'upcoming', 'friday'].includes(task.date) : task.date === activeFilters.due);
  return matchesTab && matchesQuery && matchesProject && matchesPriority && matchesStatus && matchesDue;
}

function renderTasks() {
  const sourceTasks = remoteSearchResults ?? tasks;
  const filtered = sourceTasks.filter(taskMatchesFilters);
  const groups = ['overdue', 'today', 'tomorrow', 'upcoming', 'friday', 'someday'];
  $('#taskList').innerHTML = groups.map(group => {
    const items = filtered.filter(task => task.date === group);
    if (!items.length) return '';
    return `<div class="task-group"><div class="task-group-title">${readableDate(group)} · ${items.length}</div>${items.map(task => `<div class="list-task ${task.status === 'done' ? 'completed' : ''}">
      ${taskCheck(task)}<div><strong>${task.title}</strong><small>${task.duration}${task.notes ? ` · ${task.notes}` : ''}</small></div>
      <span class="task-project"><i class="project-dot ${task.color}"></i>${task.project}</span><span class="due-date ${group === 'today' && task.status !== 'done' ? 'overdue' : ''}">${task.time || '—'}</span>
    </div>`).join('')}</div>`;
  }).join('') || '<div class="empty-task-state"><span>⌕</span><strong>No matching tasks</strong><p>Try clearing a filter or searching for something else.</p><button class="secondary-button" data-clear-filters>Clear filters</button></div>';
  $('#resultsSummary').textContent = `${filtered.length} of ${tasks.length} tasks${persistenceMode === 'remote' ? ' · Synced' : ' · Local preview'}`;
  renderActiveFilterChips();
}

function renderUpcoming() {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const days = [
    { ids: ['tomorrow'], day: 'Tomorrow', date: tomorrow.toLocaleDateString('en-AU', { weekday: 'long', month: 'short', day: 'numeric' }) },
    { ids: ['upcoming', 'friday'], day: 'Next seven days', date: 'Scheduled' },
    { ids: ['someday'], day: 'Backlog', date: 'No date' }
  ];
  $('#upcomingList').innerHTML = days.map(day => {
    const items = tasks.filter(task => day.ids.includes(task.date) && task.status !== 'done');
    return `<section class="upcoming-day"><div><h2>${day.day}</h2><span>${day.date}</span></div><div class="upcoming-tasks">${items.length ? items.map(task => `<article class="upcoming-task">${taskCheck(task)}<div><strong>${task.title}</strong><small>${task.project} · ${task.duration}</small></div><span class="due-date">${task.time}</span></article>`).join('') : '<span class="heading-subtitle">Nothing planned.</span>'}</div></section>`;
  }).join('');
}

function renderCalendar() {
  const now = new Date();
  const base = new Date(now);
  const mondayDelta = (now.getDay() + 6) % 7;
  base.setDate(now.getDate() - mondayDelta + weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(base); date.setDate(base.getDate() + index); return date;
  });
  const month = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
  $('#calendarMonth').textContent = `${month.format(days[0])} – ${month.format(days[6])}, ${days[6].getFullYear()}`;
  const hours = ['8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM'];
  let html = '<div class="cal-corner"></div>';
  html += days.map(day => `<div class="cal-day-head ${day.toDateString() === now.toDateString() ? 'today' : ''}"><span>${day.toLocaleDateString('en', { weekday: 'short' })}</span><strong>${day.getDate()}</strong></div>`).join('');
  hours.forEach((hour, row) => {
    html += `<div class="cal-time">${hour}</div>`;
    days.forEach((day, col) => {
      const events = getCalendarEvent(row, day, col);
      html += `<div class="cal-cell">${events}</div>`;
    });
  });
  $('#weekCalendar').innerHTML = html;
}

function getCalendarEvent(row, day, col) {
  const plannedTask = tasks.find(task => {
    if (!task.scheduledAt || ['done', 'archived'].includes(task.status)) return false;
    const startsAt = new Date(task.scheduledAt);
    return startsAt.toDateString() === day.toDateString() && startsAt.getHours() === row + 8;
  });
  if (plannedTask) {
    const startsAt = new Date(plannedTask.scheduledAt);
    return `<div class="cal-event ${plannedTask.color}-event"><strong>${escapeHtml(plannedTask.title)}</strong>${timeLabel(startsAt)} · ${escapeHtml(plannedTask.duration)}</div>`;
  }
  const remote = calendarEvents.find(event => {
    if (!event.starts_at || event.all_day) return false;
    const startsAt = new Date(event.starts_at);
    return startsAt.toDateString() === day.toDateString() && startsAt.getHours() === row + 8;
  });
  if (remote) {
    const startsAt = new Date(remote.starts_at);
    const endsAt = remote.ends_at ? new Date(remote.ends_at) : null;
    const minutes = endsAt ? Math.max(1, Math.round((endsAt - startsAt) / 60000)) : 30;
    return `<div class="cal-event blue-event"><strong>${escapeHtml(remote.title)}</strong>${timeLabel(startsAt)} · ${minutes}m</div>`;
  }
  const events = {
    '1-3': ['Homepage visual QA', '9:00 · 45m', 'coral-event'],
    '2-3': ['Homepage critique', '10:30 · 45m', 'coral-event'],
    '1-4': ['Finalize type scale', '9:30 · 45m', 'coral-event'],
    '3-0': ['Team standup', '11:00 · 30m', 'sage-event'],
    '4-3': ['Write launch email', '12:00 · 60m', ''],
    '6-3': ['Dentist call', '2:00 · 15m', 'sage-event'],
    '7-4': ['Order entryway bench', '3:00 · 20m', 'sage-event'],
    '2-1': ['Research session', '10:00 · 60m', '']
  };
  const event = events[`${row}-${col}`];
  return event ? `<div class="cal-event ${event[2]}"><strong>${event[0]}</strong>${event[1]}</div>` : '';
}

async function refreshCalendarEvents() {
  const now = new Date();
  const rangeStart = new Date(now);
  rangeStart.setDate(now.getDate() - ((now.getDay() + 6) % 7) + weekOffset * 7);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeStart.getDate() + 7);
  try {
    calendarEvents = await loadCalendarEvents(rangeStart, rangeEnd);
    renderCalendar();
  } catch (error) {
    if (!String(error.message).includes('calendar_events')) showToast(`Calendar unavailable: ${error.message}`);
  }
}

function setCalendarSyncState(state, label) {
  const button = $('#syncButton');
  button.classList.toggle('syncing', state === 'syncing');
  $('.sync-dot', button).dataset.state = state;
  $('span:nth-of-type(1)', button).textContent = label;
}

function plannerCandidates() {
  const priorityRank = { urgent: 0, high: 1, medium: 2, low: 3 };
  const dateRank = { overdue: 0, today: 1, tomorrow: 2, upcoming: 3, friday: 3, someday: 4 };
  return tasks
    .filter(task => !['done', 'archived'].includes(task.status))
    .sort((a, b) => (dateRank[a.date] ?? 5) - (dateRank[b.date] ?? 5) || (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2) || a.position - b.position)
    .slice(0, 30);
}

function plannerBusyIntervals() {
  if (!planningDate) return [];
  return calendarEvents
    .filter(event => !event.all_day && event.starts_at && event.ends_at && localDateKey(new Date(event.starts_at)) === planningDate)
    .map(event => ({ start: new Date(event.starts_at), end: new Date(event.ends_at), title: event.title }))
    .sort((a, b) => a.start - b.start);
}

function dayAt(time) {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(`${planningDate}T00:00:00`);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function mergeIntervals(intervals) {
  return intervals.reduce((merged, interval) => {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = new Date(Math.max(previous.end, interval.end));
    else merged.push({ ...interval });
    return merged;
  }, []);
}

function autoArrangePlan() {
  const start = dayAt($('#workdayStartInput').value);
  const end = dayAt($('#workdayEndInput').value);
  if (end <= start) {
    showToast('Finish time needs to be after start time');
    return;
  }
  const busy = mergeIntervals(plannerBusyIntervals().map(interval => ({
    ...interval,
    start: new Date(Math.max(interval.start, start)),
    end: new Date(Math.min(interval.end, end))
  })).filter(interval => interval.end > interval.start));
  const selectedTasks = plannerCandidates().filter(task => planningSelected.has(String(task.id)));
  let cursor = new Date(start);
  planningSchedule = selectedTasks.map(task => {
    const duration = planningDurations.get(String(task.id)) || task.plannedMinutes || Number.parseInt(task.duration, 10) || 30;
    cursor.setMinutes(Math.ceil(cursor.getMinutes() / 15) * 15, 0, 0);
    let slotEnd = new Date(cursor.getTime() + duration * 60000);
    let collision = busy.find(interval => cursor < interval.end && slotEnd > interval.start);
    while (collision) {
      cursor = new Date(collision.end);
      cursor.setMinutes(Math.ceil(cursor.getMinutes() / 15) * 15, 0, 0);
      slotEnd = new Date(cursor.getTime() + duration * 60000);
      collision = busy.find(interval => cursor < interval.end && slotEnd > interval.start);
    }
    const fits = slotEnd <= end;
    const item = { taskId: String(task.id), plannedMinutes: duration, scheduledAt: fits ? cursor.toISOString() : null };
    if (fits) cursor = slotEnd;
    return item;
  });
  renderPlanner();
}

function plannerCapacity() {
  const start = dayAt($('#workdayStartInput').value);
  const end = dayAt($('#workdayEndInput').value);
  const busy = mergeIntervals(plannerBusyIntervals().map(interval => ({
    start: new Date(Math.max(interval.start, start)),
    end: new Date(Math.min(interval.end, end))
  })).filter(interval => interval.end > interval.start));
  const busyMinutes = busy.reduce((total, interval) => total + Math.max(0, (interval.end - interval.start) / 60000), 0);
  return Math.max(0, Math.round((end - start) / 60000 - busyMinutes));
}

function plannerConflicts() {
  const workdayStart = dayAt($('#workdayStartInput').value);
  const workdayEnd = dayAt($('#workdayEndInput').value);
  const busy = plannerBusyIntervals();
  const scheduled = planningSchedule
    .filter(item => item.scheduledAt)
    .map(item => ({ ...item, start: new Date(item.scheduledAt), end: new Date(new Date(item.scheduledAt).getTime() + item.plannedMinutes * 60000) }));
  const conflicts = new Set();
  scheduled.forEach((item, index) => {
    if (item.start < workdayStart || item.end > workdayEnd) conflicts.add(item.taskId);
    if (busy.some(interval => item.start < interval.end && item.end > interval.start)) conflicts.add(item.taskId);
    scheduled.slice(index + 1).forEach(other => {
      if (item.start < other.end && item.end > other.start) {
        conflicts.add(item.taskId);
        conflicts.add(other.taskId);
      }
    });
  });
  return conflicts;
}

function renderPlanner() {
  const candidates = plannerCandidates();
  $('#planningTaskList').innerHTML = candidates.length ? candidates.map(task => {
    const id = String(task.id);
    const duration = planningDurations.get(id) || task.plannedMinutes || Number.parseInt(task.duration, 10) || 30;
    return `<label class="planning-task ${planningSelected.has(id) ? 'selected' : ''}">
      <input type="checkbox" data-plan-task="${escapeHtml(id)}" ${planningSelected.has(id) ? 'checked' : ''} />
      <div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.project)} · ${escapeHtml(readableDate(task.date))} · ${escapeHtml(task.priority)}</small></div>
      <select data-plan-duration="${escapeHtml(id)}" aria-label="Duration for ${escapeHtml(task.title)}">
        ${[15, 30, 45, 60, 90, 120].map(value => `<option value="${value}" ${value === duration ? 'selected' : ''}>${minutesLabel(value)}</option>`).join('')}
      </select>
    </label>`;
  }).join('') : '<div class="planning-empty">Your open task list is clear.<br />Add something worth doing first.</div>';

  const busy = plannerBusyIntervals().map(interval => ({ type: 'busy', ...interval }));
  const scheduled = planningSchedule.map(item => {
    const task = tasks.find(candidate => String(candidate.id) === item.taskId);
    return { type: 'task', ...item, task, start: item.scheduledAt ? new Date(item.scheduledAt) : null };
  });
  const conflicts = plannerConflicts();
  const rows = [...busy, ...scheduled.filter(item => item.start)].sort((a, b) => a.start - b.start);
  $('#planningSlots').innerHTML = [
    ...rows.map(item => item.type === 'busy'
      ? `<div class="busy-slot"><time>${timeLabel(item.start)}</time><strong>${escapeHtml(item.title)}</strong></div>`
      : `<div class="planned-slot ${conflicts.has(item.taskId) ? 'conflict' : ''}"><input class="planned-time-input" type="time" step="900" data-plan-time="${escapeHtml(item.taskId)}" value="${String(item.start.getHours()).padStart(2, '0')}:${String(item.start.getMinutes()).padStart(2, '0')}" aria-label="Start time for ${escapeHtml(item.task?.title)}" /><div><strong>${escapeHtml(item.task?.title)}</strong><small>${conflicts.has(item.taskId) ? 'Conflicts with another block' : escapeHtml(item.task?.project)}</small></div><span>${minutesLabel(item.plannedMinutes)}</span></div>`),
    ...scheduled.filter(item => !item.start).map(item => `<div class="planned-slot conflict"><time>—</time><div><strong>${escapeHtml(item.task?.title)}</strong><small>Doesn’t fit in this workday</small></div><span>${minutesLabel(item.plannedMinutes)}</span></div>`)
  ].join('') || '<div class="planning-empty">Choose tasks on the left,<br />then auto-arrange your day.</div>';

  const plannedMinutes = [...planningSelected].reduce((total, id) => total + (planningDurations.get(id) || tasks.find(task => String(task.id) === id)?.plannedMinutes || 30), 0);
  const availableMinutes = plannerCapacity();
  const ratio = availableMinutes ? plannedMinutes / availableMinutes : 1;
  $('#capacityLabel').textContent = `${minutesLabel(plannedMinutes)} planned · ${minutesLabel(availableMinutes)} free`;
  $('#capacityStatus').textContent = ratio > 1 ? 'Too much for one day' : ratio > .8 ? 'A full, focused day' : ratio > .45 ? 'Comfortably planned' : 'Plenty of breathing room';
  $('#capacityFill').style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  $('#capacityFill').style.background = ratio > 1 ? 'var(--danger)' : ratio > .8 ? 'var(--yellow)' : 'var(--sage)';
  $('#busyTimeLabel').textContent = busy.length ? `${minutesLabel(busy.reduce((sum, item) => sum + Math.round((item.end - item.start) / 60000), 0))} already booked` : 'Calendar is clear';
  $('#planningHint').textContent = conflicts.size ? 'Resolve highlighted overlaps before committing.' : 'Select tasks, then let Maki fit them around your calendar.';
  $('#commitPlanningButton').disabled = !planningSchedule.length || planningSchedule.some(item => !item.scheduledAt) || conflicts.size > 0;
}

async function openPlanner() {
  planningDate = localDateKey(new Date());
  $('#planningDateLabel').textContent = new Date(`${planningDate}T12:00:00`).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  try {
    await syncGoogleCalendar();
    await refreshCalendarEvents();
    const savedPlan = await loadDailyPlan(planningDate);
    if (savedPlan) {
      $('#workdayStartInput').value = savedPlan.workday_start.slice(0, 5);
      $('#workdayEndInput').value = savedPlan.workday_end.slice(0, 5);
    }
  } catch (error) {
    showToast(`Using local calendar view: ${error.message}`);
  }
  planningSelected = new Set(plannerCandidates().filter(task => task.date === 'today' || (task.scheduledAt && localDateKey(new Date(task.scheduledAt)) === planningDate)).map(task => String(task.id)));
  planningDurations = new Map(plannerCandidates().map(task => [String(task.id), task.plannedMinutes || Number.parseInt(task.duration, 10) || 30]));
  autoArrangePlan();
  $('#planningModal').showModal();
}

function renderProjectControls() {
  const options = projects.map(project => `<option value="${project.id}">${project.name}</option>`).join('');
  $('#projectFilter').innerHTML = `<option value="all">All projects</option>${options}`;
  $('#taskProjectInput').innerHTML = projects.map(project => `<option value="${project.name}">${project.name}</option>`).join('');
  $('#projectFilter').value = activeFilters.project;
  syncTaskDropdowns();
}

function closeTaskDropdowns(except = null) {
  $$('.smart-select').forEach(dropdown => {
    if (dropdown === except) return;
    $('.smart-select-menu', dropdown).hidden = true;
    $('.smart-select-trigger', dropdown).setAttribute('aria-expanded', 'false');
  });
}

function syncTaskDropdowns() {
  $$('.smart-select').forEach(dropdown => {
    const select = $(`#${dropdown.dataset.taskSelect}`);
    if (!select) return;
    const selected = select.options[select.selectedIndex] || select.options[0];
    $('[data-select-label]', dropdown).textContent = selected?.textContent || '';
    $('.smart-select-menu', dropdown).innerHTML = [...select.options].map(option => `<button type="button" class="smart-select-option ${option.value === select.value ? 'active' : ''}" role="option" aria-selected="${option.value === select.value}" data-select-option="${escapeHtml(option.value)}">${escapeHtml(option.textContent)}</button>`).join('');
  });
}

function renderSavedFilters() {
  $('#savedFilterNav').innerHTML = savedFilters.map(filter => `<div class="saved-filter-item">
    <button class="nav-item" data-saved-filter="${filter.id}"><svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg><span>${filter.name}</span></button>
    <button class="delete-filter-button" data-delete-filter="${filter.id}" aria-label="Delete ${filter.name}">×</button>
  </div>`).join('');
}

function renderActiveFilterChips() {
  const labels = {
    project: projects.find(project => project.id === activeFilters.project)?.name || activeFilters.project,
    priority: activeFilters.priority === 'important' ? 'High or urgent' : activeFilters.priority,
    status: activeFilters.status === 'open' ? 'Open tasks' : activeFilters.status,
    due: activeFilters.due === 'unscheduled' ? 'Unscheduled' : activeFilters.due
  };
  const chips = [];
  if (activeFilters.query) chips.push({ key: 'query', label: `“${activeFilters.query}”` });
  ['project', 'priority', 'status', 'due'].forEach(key => {
    if (activeFilters[key] !== 'all') chips.push({ key, label: labels[key] });
  });
  $('#activeFilterRow').innerHTML = chips.map(chip => `<span class="filter-chip">${chip.label}<button data-remove-filter="${chip.key}" aria-label="Remove ${chip.label} filter">×</button></span>`).join('');
  const count = chips.length;
  $('#filterBadge').hidden = count === 0;
  $('#filterBadge').textContent = count;
  $('#filterButton').classList.toggle('active', count > 0 || !$('#filterPanel').hidden);
}

function syncFilterControls() {
  $('#taskSearchInput').value = activeFilters.query;
  $('#projectFilter').value = activeFilters.project;
  $('#priorityFilter').value = activeFilters.priority;
  $('#statusFilter').value = activeFilters.status;
  $('#dueFilter').value = activeFilters.due;
}

function resetFilters() {
  activeFilters = { query: '', project: 'all', priority: 'all', status: 'all', due: 'all' };
  remoteSearchResults = null;
  currentFilter = 'all';
  $$('.segmented [data-filter]').forEach(item => item.classList.toggle('active', item.dataset.filter === 'all'));
  syncFilterControls();
  renderTasks();
  bindDynamicControls();
}

function renderAll() {
  updateCounts(); renderProjectControls(); renderSavedFilters(); renderTimeline(); renderBoard(); renderTasks(); renderUpcoming(); renderCalendar(); bindDynamicControls();
}

function bindDynamicControls() {
  $$('[data-complete]').forEach(button => button.onclick = () => toggleTask(button.dataset.complete));
  $$('[data-open-task]').forEach(button => button.onclick = openTaskModal);
  $$('[data-clear-filters]').forEach(button => button.onclick = resetFilters);
  $$('[data-remove-filter]').forEach(button => button.onclick = () => {
    const key = button.dataset.removeFilter;
    activeFilters[key] = key === 'query' ? '' : 'all';
    syncFilterControls(); renderTasks(); bindDynamicControls();
  });
}

async function toggleTask(id) {
  const previous = tasks;
  const current = tasks.find(task => String(task.id) === String(id));
  if (!current) return;
  const status = current.status === 'done' ? 'todo' : 'done';
  tasks = tasks.map(task => String(task.id) === String(id) ? { ...task, status } : task);
  save(); renderAll(); showToast(status === 'done' ? 'Task complete' : 'Task reopened');
  try {
    await updateTask(current.id, { status });
  } catch (error) {
    tasks = previous; save(); renderAll(); showToast(`Couldn’t save: ${error.message}`);
  }
}

function bindDragAndDrop() {
  $$('.kanban-card').forEach(card => {
    card.addEventListener('dragstart', () => card.classList.add('dragging'));
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  $$('.kanban-cards').forEach(column => {
    column.addEventListener('dragover', event => { event.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', event => {
      event.preventDefault();
      const card = $('.kanban-card.dragging');
      if (!card) return;
      const id = card.dataset.id;
      const previous = tasks;
      tasks = tasks.map(task => String(task.id) === id ? { ...task, status: column.dataset.status } : task);
      save(); renderAll(); showToast(`Moved to ${column.dataset.status === 'progress' ? 'In progress' : column.dataset.status}`);
      updateTask(id, { status: column.dataset.status }).catch(error => {
        tasks = previous; save(); renderAll(); showToast(`Couldn’t move task: ${error.message}`);
      });
    });
  });
}

function switchView(view, trigger) {
  $$('.view').forEach(section => section.classList.toggle('active', section.dataset.view === view));
  if (view === 'board' && trigger?.dataset.project) {
    activeProject = trigger.dataset.project;
    $('#boardTitle').textContent = activeProject;
    renderBoard(); bindDynamicControls();
  }
  $$('[data-view-target]').forEach(button => {
    const isActiveView = button.dataset.viewTarget === view;
    const isActiveProject = view !== 'board' || button.dataset.project === activeProject;
    button.classList.toggle('active', isActiveView && isActiveProject);
  });
  $('.sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openTaskModal() {
  closeTaskDropdowns();
  syncTaskDropdowns();
  $('#taskModal').showModal();
  setTimeout(() => $('#taskTitleInput').focus(), 50);
}
function closeTaskModal() { closeTaskDropdowns(); $('#taskModal').close(); }

function openSearch() {
  $('#commandPalette').classList.add('open');
  $('#overlay').classList.add('open');
  $('#commandPalette').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#globalSearch').focus(), 50);
}
function closeSearch() {
  $('#commandPalette').classList.remove('open');
  $('#overlay').classList.remove('open');
  $('#commandPalette').setAttribute('aria-hidden', 'true');
  $('#globalSearch').value = '';
}

function initTheme() {
  const stored = localStorage.getItem('maki-theme') || 'dark';
  document.documentElement.dataset.theme = stored;
  updateThemeButton(stored);
}

function initDateAndGreeting() {
  const now = new Date();
  $('#topbarDay').textContent = now.toLocaleDateString('en-AU', { weekday: 'long' });
  $('#topbarDate').textContent = now.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
  $('.today-heading h1').textContent = `${greeting}, Alex.`;
}
function updateThemeButton(theme) {
  $('#themeButton').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#161616' : '#ffffff';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('maki-theme', next);
  updateThemeButton(next); showToast(`${next === 'dark' ? 'Dark' : 'Light'} mode on`);
}

function startFocus() {
  $('#focusOverlay').classList.add('open');
  focusRunning = true;
  $('#focusToggle').textContent = 'Pause';
  if (!focusInterval) focusInterval = setInterval(() => {
    if (!focusRunning || focusSeconds <= 0) return;
    focusSeconds -= 1;
    const minutes = String(Math.floor(focusSeconds / 60)).padStart(2, '0');
    const seconds = String(focusSeconds % 60).padStart(2, '0');
    $('#focusTimer').textContent = `${minutes}:${seconds}`;
  }, 1000);
}

document.addEventListener('click', event => {
  const dropdownOption = event.target.closest('[data-select-option]');
  if (dropdownOption) {
    const dropdown = dropdownOption.closest('.smart-select');
    const select = $(`#${dropdown.dataset.taskSelect}`);
    select.value = dropdownOption.dataset.selectOption;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncTaskDropdowns();
    closeTaskDropdowns();
    $('.smart-select-trigger', dropdown).focus();
    return;
  }
  const dropdownTrigger = event.target.closest('.smart-select-trigger');
  if (dropdownTrigger) {
    const dropdown = dropdownTrigger.closest('.smart-select');
    const menu = $('.smart-select-menu', dropdown);
    const shouldOpen = menu.hidden;
    closeTaskDropdowns(dropdown);
    menu.hidden = !shouldOpen;
    dropdownTrigger.setAttribute('aria-expanded', String(shouldOpen));
    return;
  }
  if (!event.target.closest('.smart-select')) closeTaskDropdowns();

  const target = event.target.closest('[data-view-target]');
  if (target) { switchView(target.dataset.viewTarget, target); closeSearch(); }
  const switcher = event.target.closest('[data-switch]');
  if (switcher) switchView(switcher.dataset.switch);
  const smartView = event.target.closest('[data-smart-view]');
  if (smartView) {
    resetFilters();
    if (smartView.dataset.smartView === 'high') activeFilters = { ...activeFilters, priority: 'important', status: 'open' };
    if (smartView.dataset.smartView === 'unscheduled') activeFilters = { ...activeFilters, due: 'unscheduled', status: 'open' };
    syncFilterControls(); switchView('tasks'); renderTasks(); bindDynamicControls();
  }
  const savedView = event.target.closest('[data-saved-filter]');
  if (savedView) {
    const filter = savedFilters.find(item => item.id === savedView.dataset.savedFilter);
    if (filter) {
      activeFilters = { query: '', project: 'all', priority: 'all', status: 'all', due: 'all', ...filter.definition };
      currentFilter = filter.definition.tab || 'all';
      syncFilterControls(); switchView('tasks'); renderTasks(); bindDynamicControls();
    }
  }
  const deleteFilter = event.target.closest('[data-delete-filter]');
  if (deleteFilter) {
    event.stopPropagation();
    const id = deleteFilter.dataset.deleteFilter;
    const previous = savedFilters;
    savedFilters = savedFilters.filter(filter => filter.id !== id);
    renderSavedFilters();
    deleteSavedFilter(id).catch(error => { savedFilters = previous; renderSavedFilters(); showToast(`Couldn’t delete view: ${error.message}`); });
  }
});

$('#quickAddButton').onclick = openTaskModal;
$('#closeModal').onclick = closeTaskModal;
$('#searchButton').onclick = openSearch;
$('#overlay').onclick = closeSearch;
$('#themeButton').onclick = toggleTheme;
$('#mobileMenu').onclick = () => $('.sidebar').classList.toggle('open');
$('#syncButton').onclick = async function () {
  const auth = getAuthState();
  if (!auth.configured) { showToast('Add your Supabase environment variables first'); return; }
  if (!auth.user) { await signInWithGoogle(); return; }
  setCalendarSyncState('syncing', 'Syncing Calendar…');
  try {
    const result = await syncGoogleCalendar();
    if (!result?.connected) {
      const error = await connectGoogleCalendar();
      if (error) throw error;
      return;
    }
    await refreshCalendarEvents();
    setCalendarSyncState('connected', 'Google Calendar');
    showToast('Calendar is up to date');
  } catch (error) {
    setCalendarSyncState('error', 'Reconnect Calendar');
    showToast(`Calendar sync needs attention: ${error.message}`);
  }
};
$('#scheduleSwitch').onclick = function () { this.classList.toggle('on'); this.setAttribute('aria-checked', this.classList.contains('on')); };
$('#focusButton').onclick = startFocus;
$('#focusClose').onclick = () => $('#focusOverlay').classList.remove('open');
$('#focusToggle').onclick = function () { focusRunning = !focusRunning; this.textContent = focusRunning ? 'Pause' : 'Resume'; };
$('#prevWeek').onclick = () => { weekOffset--; refreshCalendarEvents(); };
$('#nextWeek').onclick = () => { weekOffset++; refreshCalendarEvents(); };
$('#calendarTodayButton').onclick = () => { weekOffset = 0; refreshCalendarEvents(); };
$('#planDayButton').onclick = openPlanner;
$('#addProjectButton').onclick = () => showToast('Project creation is ready for you');

$('#closePlanningButton').onclick = () => $('#planningModal').close();
$('#cancelPlanningButton').onclick = () => $('#planningModal').close();
$('#autoPlanButton').onclick = autoArrangePlan;
$('#workdayStartInput').addEventListener('change', autoArrangePlan);
$('#workdayEndInput').addEventListener('change', autoArrangePlan);
$('#planningTaskList').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-plan-task]');
  if (checkbox) {
    if (checkbox.checked) planningSelected.add(checkbox.dataset.planTask);
    else planningSelected.delete(checkbox.dataset.planTask);
    autoArrangePlan();
    return;
  }
  const duration = event.target.closest('[data-plan-duration]');
  if (duration) {
    planningDurations.set(duration.dataset.planDuration, Number(duration.value));
    if (planningSelected.has(duration.dataset.planDuration)) autoArrangePlan();
  }
});
$('#planningSlots').addEventListener('change', event => {
  const input = event.target.closest('[data-plan-time]');
  if (!input) return;
  const item = planningSchedule.find(candidate => candidate.taskId === input.dataset.planTime);
  if (!item) return;
  item.scheduledAt = dayAt(input.value).toISOString();
  renderPlanner();
});
$('#planningForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!planningSchedule.length || planningSchedule.some(item => !item.scheduledAt) || plannerConflicts().size) {
    showToast('Make room for every selected task before committing');
    return;
  }
  const button = $('#commitPlanningButton');
  button.disabled = true;
  button.textContent = 'Committing…';
  try {
    const result = await commitDayPlan({
      planDate: planningDate,
      workdayStart: $('#workdayStartInput').value,
      workdayEnd: $('#workdayEndInput').value,
      items: planningSchedule
    });
    const returnedTasks = new Map((result.tasks || []).map(task => [String(task.id), task]));
    tasks = tasks.map(task => {
      const remote = returnedTasks.get(String(task.id));
      if (remote) return remote;
      const planned = planningSchedule.find(item => item.taskId === String(task.id));
      if (!planned) return task;
      const startsAt = new Date(planned.scheduledAt);
      return {
        ...task,
        date: 'today',
        dueDate: planningDate,
        scheduledAt: planned.scheduledAt,
        time: `${startsAt.getHours() % 12 || 12}:${String(startsAt.getMinutes()).padStart(2, '0')}`,
        plannedMinutes: planned.plannedMinutes,
        duration: `${planned.plannedMinutes}m`
      };
    });
    save();
    renderAll();
    await refreshCalendarEvents();
    $('#planningModal').close();
    showToast(`Day committed · ${minutesLabel(planningSchedule.reduce((sum, item) => sum + item.plannedMinutes, 0))} protected`);
  } catch (error) {
    showToast(`Couldn’t commit plan: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Commit plan';
  }
});

$$('.segmented [data-filter]').forEach(button => button.onclick = () => {
  currentFilter = button.dataset.filter;
  $$('.segmented [data-filter]').forEach(item => item.classList.toggle('active', item === button));
  renderTasks(); bindDynamicControls();
});

$('#taskSearchInput').addEventListener('input', event => {
  activeFilters.query = event.target.value;
  remoteSearchResults = null;
  renderTasks(); bindDynamicControls();
  clearTimeout($('#taskSearchInput').searchTimer);
  if (!activeFilters.query.trim()) return;
  $('#taskSearchInput').searchTimer = setTimeout(async () => {
    const query = activeFilters.query.trim();
    try {
      const results = await searchWorkspaceTasks(query);
      if (results && $('#taskSearchInput').value.trim() === query) {
        remoteSearchResults = results;
        renderTasks(); bindDynamicControls();
      }
    } catch (error) {
      showToast(`Search fallback active: ${error.message}`);
    }
  }, 220);
});

$('#filterButton').onclick = () => {
  $('#filterPanel').hidden = !$('#filterPanel').hidden;
  renderActiveFilterChips();
};

[
  ['#projectFilter', 'project'],
  ['#priorityFilter', 'priority'],
  ['#statusFilter', 'status'],
  ['#dueFilter', 'due']
].forEach(([selector, key]) => {
  $(selector).addEventListener('change', event => {
    activeFilters[key] = event.target.value;
    renderTasks(); bindDynamicControls();
  });
});

$('#resetFilterButton').onclick = resetFilters;
$('#showSaveFilterButton').onclick = () => {
  $('#showSaveFilterButton').hidden = true;
  $('#saveFilterRow').hidden = false;
  $('#filterNameInput').focus();
};
$('#confirmSaveFilterButton').onclick = async () => {
  const name = $('#filterNameInput').value.trim();
  if (!name) { $('#filterNameInput').focus(); return; }
  const button = $('#confirmSaveFilterButton');
  button.disabled = true;
  try {
    const filter = await createSavedFilter(name, { ...activeFilters, tab: currentFilter });
    savedFilters = [...savedFilters, filter];
    renderSavedFilters();
    $('#filterNameInput').value = '';
    $('#saveFilterRow').hidden = true;
    $('#showSaveFilterButton').hidden = false;
    showToast('Smart view saved');
  } catch (error) {
    showToast(`Couldn’t save view: ${error.message}`);
  } finally {
    button.disabled = false;
  }
};

$('#taskForm').addEventListener('submit', async event => {
  event.preventDefault();
  const title = $('#taskTitleInput').value.trim();
  if (!title) return;
  const project = $('#taskProjectInput').value;
  const task = {
    id: crypto.randomUUID(), title, project, notes: $('#taskNotesInput').value.trim(), date: $('#taskDateInput').value,
    time: $('#scheduleSwitch').classList.contains('on') ? '3:30' : '', duration: '30m', status: 'todo',
    priority: $('#taskPriorityInput').value, color: colorForProject(project)
  };
  tasks.unshift(task); save(); renderAll(); closeTaskModal(); event.target.reset(); syncTaskDropdowns(); $('#scheduleSwitch').classList.remove('on'); showToast('Task added');
  try {
    const savedTask = await createTask(task);
    tasks = tasks.map(item => item.id === task.id ? savedTask : item);
    save(); renderAll();
  } catch (error) {
    tasks = tasks.filter(item => item.id !== task.id);
    save(); renderAll(); showToast(`Couldn’t save task: ${error.message}`);
  }
});

$('#globalSearch').addEventListener('input', event => {
  const query = event.target.value.toLowerCase().trim();
  const matches = tasks.filter(task => task.title.toLowerCase().includes(query) || task.project.toLowerCase().includes(query)).slice(0, 6);
  $('#searchResults').innerHTML = query ? `<p>Results</p>${matches.map(task => `<button data-search-task="${task.id}"><span>${task.title}<small style="display:block;color:var(--faint);font-size:8px;margin-top:2px">${task.project}</small></span><kbd>${readableDate(task.date)}</kbd></button>`).join('') || '<p>No matching tasks</p>'}` : '<p>Jump to</p><button data-view-target="today"><span>Today</span><kbd>G T</kbd></button><button data-view-target="tasks"><span>All tasks</span><kbd>G A</kbd></button><button data-view-target="calendar"><span>Calendar</span><kbd>G C</kbd></button>';
  $$('[data-search-task]').forEach(button => button.onclick = () => { currentFilter = 'all'; switchView('tasks'); closeSearch(); });
});

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && $('#taskModal').open) $('#taskForm').requestSubmit();
  if (event.key.toLowerCase() === 'n' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !$('#taskModal').open) openTaskModal();
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); openSearch(); }
  if (event.key === 'Escape') { closeTaskDropdowns(); closeSearch(); $('.sidebar').classList.remove('open'); }
});

$('.notification-button').onclick = () => showToast('You’re all caught up');
$('.insight-card button').onclick = event => event.currentTarget.closest('.insight-card').remove();
$$('.habit-check').forEach(button => button.onclick = () => { button.classList.toggle('done'); button.textContent = button.classList.contains('done') ? '✓' : ''; });

initTheme();
initDateAndGreeting();
renderAll();

async function hydratePersistence(user) {
  const key = user?.id || 'local';
  if (hydratedUserId === key) return;
  hydratedUserId = key;
  stopWorkspaceSubscription();
  try {
    const workspace = await loadWorkspace(initialTasks);
    tasks = workspace.tasks;
    projects = workspace.projects;
    savedFilters = workspace.savedFilters;
    persistenceMode = workspace.mode;
    activeProject = projects[0]?.name || 'Inbox';
    renderAll();
    if (user && workspace.mode === 'remote') {
      stopWorkspaceSubscription = subscribeToWorkspace(user.id, async () => {
        try {
          const refreshed = await loadWorkspace([]);
          tasks = refreshed.tasks; projects = refreshed.projects; savedFilters = refreshed.savedFilters;
          renderAll();
        } catch (error) {
          showToast(`Sync paused: ${error.message}`);
        }
      });
    }
  } catch (error) {
    persistenceMode = 'local';
    hydratedUserId = null;
    renderAll();
    showToast(`Database unavailable: ${error.message}`);
  }
}

$('#googleSignInButton').onclick = async () => {
  const button = $('#googleSignInButton');
  button.disabled = true;
  button.textContent = 'Opening Google…';
  const error = await signInWithGoogle();
  if (error) {
    button.disabled = false;
    button.textContent = 'Continue with Google';
    $('#authStatus').textContent = error.message;
  }
};

$('#magicLinkForm').addEventListener('submit', async event => {
  event.preventDefault();
  const email = $('#magicLinkEmail').value.trim();
  const button = $('#magicLinkForm button');
  button.disabled = true;
  button.textContent = 'Sending…';
  $('#authStatus').textContent = '';
  const error = await signInWithMagicLink(email);
  if (error) {
    $('#authStatus').textContent = error.message;
    button.disabled = false;
    button.textContent = 'Email me a link';
    return;
  }
  $('#authStatus').textContent = `Check ${email} — your sign-in link is on the way.`;
  $('#authStatus').classList.add('success');
  button.textContent = 'Link sent';
});

initAuth({
  onReady: async ({ configured, user, providerToken, providerRefreshToken, error }) => {
    $('#authGate').hidden = !configured || Boolean(user);
    $('.app-shell').hidden = configured && !user;
    if (error) $('#authStatus').textContent = error.message;
    if (!user) {
      if (!configured) await hydratePersistence(null);
      return;
    }
    const metadata = user.user_metadata || {};
    const fullName = metadata.full_name || metadata.name || user.email?.split('@')[0] || 'Maki user';
    $('.profile-row strong').textContent = fullName;
    $('.profile-row small').textContent = user.email || '';
    renderProfileAvatar(user, fullName);
    await hydratePersistence(user);
    if (providerToken) {
      try {
        await saveGoogleGrant(providerToken, providerRefreshToken);
        setCalendarSyncState('connected', 'Google Calendar');
      } catch (calendarError) {
        setCalendarSyncState('error', 'Reconnect Calendar');
        showToast(`Calendar connection needs attention: ${calendarError.message}`);
      }
    }
    if (calendarSyncUserId !== user.id) {
      calendarSyncUserId = user.id;
      startCalendarSync(user.id, {
        onSync: async result => {
          setCalendarSyncState(result?.connected ? 'connected' : 'disconnected', result?.connected ? 'Google Calendar' : 'Connect Calendar');
          if (result?.connected) await refreshCalendarEvents();
        },
        onChange: refreshCalendarEvents,
        onError: () => setCalendarSyncState('error', 'Reconnect Calendar')
      });
    }
    await refreshCalendarEvents();
    if (persistenceMode === 'remote') showToast('Workspace synced');
  }
});
