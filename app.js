import { completeGoogleCalendarConsent, connectGoogleCalendar, initAuth, signInWithGoogle, signInWithMagicLink, signOut, getAuthState } from './supabase.js';
import { commitDayPlan, createSavedFilter, createTask, deleteSavedFilter, deleteTask, loadDailyPlan, loadOnboardingPreferences, loadWorkspace, persistLocalTasks, saveOnboardingPreferences, searchWorkspaceTasks, subscribeToWorkspace, updateTask } from './data.js';
import { loadCalendarEvents, saveGoogleGrant, startCalendarSync, stopCalendarSync, syncGoogleCalendar } from './calendar.js';

// Keep analytics off the critical path and avoid recording OAuth callback URLs.
if (import.meta.env.PROD) {
  import('@vercel/analytics').then(({ inject }) => inject({
    beforeSend: event => event.url.includes('/auth/') ? null : event
  }));
}
import { renderDitherAvatar } from './dither-avatar.js';

let tasks = [];
let trashedTasks = (JSON.parse(localStorage.getItem('maki-trash') || 'null') || []).filter(item => Date.now() - new Date(item.deletedAt).getTime() < 7 * 86400000);
let projects = [];
let savedFilters = [];
let persistenceMode = 'local';
let hydratedUserId = null;
let stopWorkspaceSubscription = () => {};
let activeProject = 'Inbox';
let projectViewScope = null;
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
let planningObstacles = '';
let planningShareToMaki = true;
let planningShareToEmail = false;
let planningExtraDestinations = [];
let guidedPlanning = false;
let guidedPlanningStage = 5;
let guidedPlanningMaxStage = 5;
let focusSeconds = 25 * 60;
let focusRunning = true;
let focusMode = 'focus';
let currentFocusTaskId = null;
let workspaceFocusInterval = null;
let workspaceFocusRunning = false;
let activeRitual = 'planning';
let settingsPage = 'general';
let settingsPreferences = {
  weekStart: 'monday', timeZoneAlert: true, timeFormat: 'device', countPlannedAsActual: true, autoSortTasks: true,
  newTaskPosition: 'top', rolloverPosition: 'top', priorityRollover: 'none', workloadHours: 8,
  theme: 'dark', density: 'comfortable', calendarEventColor: 'calendar', hideCompletedTasks: false,
  hideCompletedCalendar: false, celebrationAnimations: true, spellcheck: true, supportBubble: true,
  planningRitual: true, shutdownRitual: true, highlightsRitual: true, planningTime: '08:45', shutdownTime: '16:45',
  automatedPlanning: false, automatedShutdown: false, includeWeekends: false, dailyHighlightsSchedule: 'daily',
  taskProjections: true, conflictWarnings: true, splitTasks: false, focusMinutes: 45, pomodoroMinutes: 25, breakMinutes: 5,
  strongProjections: false, showActualTime: true, hidePlannedWhenComplete: false, calendarPrivacy: 'private',
  autoScheduleGap: 5, defaultTaskDuration: 30, rescheduleConflicts: true, rescheduleEarlyFinish: true,
  focusBar: false, betaFeatures: false, desktopNotifications: true, planningReminders: true, shutdownReminders: true,
  meetingImport: 'review', autoCompleteMeetings: true, meetingExclusions: true,
  ...(JSON.parse(localStorage.getItem('maki-settings') || 'null') || {})
};
let onboardingSelection = new Set();
let onboardingWorkdayStart = '09:00';
let onboardingWorkdayEnd = '17:00';
let onboardingPlanningRitual = 'start_of_day';
let onboardingFirstPlanDate = null;
let onboardingWorkContext = '';
let onboardingFirstDayGoal = '';
let taskAutomationTouched = new Set();
let activeTaskDetailId = null;
let detailCalendarCursor = new Date();
let detailSubtaskSaveTimer = null;
let activeDurationSubtaskId = null;

const DETAIL_DURATION_OPTIONS = [5, 10, 15, 20, 25, 30, 45, 60, 90, 120, 150, 180, 240, 300];

const DEFAULT_AUTOMATIONS = {
  conflict_aware_planning: true,
  workday_boundaries: true,
  duration_suggestions: true,
  project_suggestions: true
};

const CONNECTORS = [
  ['asana', 'Asana', '#f06a6a', 'A'], ['linear', 'Linear', '#6c6df1', 'L'],
  ['clickup', 'ClickUp', '#c958e8', 'C'], ['monday', 'Monday.com', '#ffcc3d', 'M'],
  ['github', 'GitHub', '#8f96a3', 'GH'], ['notion', 'Notion', '#e5e5e5', 'N'],
  ['gmail', 'Gmail', '#ea4335', 'G'], ['outlook', 'Outlook', '#1689e8', 'O'],
  ['google_tasks', 'Google Tasks', '#4285f4', 'GT'], ['todoist', 'Todoist', '#e44332', 'T'],
  ['jira', 'Jira', '#2684ff', 'J'], ['trello', 'Trello', '#0c66e4', 'Tr']
];

const SHORTCUT_GROUPS = [
  ['General', [['Open command menu', ['⌘', 'K']], ['Show keyboard shortcuts', ['?']], ['Toggle AI voice assistant', ['Y'], true]]],
  ['Global', [['Add task', ['⌘', '⇧', 'A']], ['Play/pause timer', ['⌘', '⇧', 'Space']], ['Toggle AI voice assistant', ['⌘', '⇧', 'Y'], true]]],
  ['Task creation', [['Add task', ['A']], ['Add task as subtask', ['A', 'then', '>']]]],
  ['Task actions', [['Assign project', ['Q', 'or', '#']], ['Set planned time', ['W', 'or', '~']], ['Set priority', ['!']], ['Set start date', ['@']], ['Start or stop timer', ['Space']], ['Add subtask', ['V']], ['Complete task', ['C']], ['Delete task', ['⌘', 'Delete']], ['Open task', ['⌘', 'Enter']], ['Duplicate task', ['⌘', 'D']], ['Undo command', ['⌘', 'Z'], true]]],
  ['Task scheduling', [['Auto-schedule task', ['X']], ['Remove task from calendar', ['⌘', 'X']], ['Schedule to today', ['S']], ['Snooze one day', ['D']], ['Move to backlog', ['Z']]]],
  ['Task ordering', [['Move task down', ['⌘', '↓'], true], ['Move task up', ['⌘', '↑'], true], ['Move task to bottom', ['⌘', '⇧', '↓'], true], ['Move task to top', ['⌘', '⇧', '↑'], true]]],
  ['Task navigation', [['Select next task', ['↓'], true], ['Select previous task', ['↑'], true], ['Select first task next day', ['→'], true], ['Select first task previous day', ['←'], true]]],
  ['Focus', [['Enter focus mode', ['F']], ['Take a break', ['K']]]],
  ['Date navigation', [['Jump to today', ['⇧', 'Space']], ['Jump forward a day', ['⇧', '→'], true], ['Jump backward a day', ['⇧', '←'], true]]],
  ['Page navigation', [['Filter tasks', ['⇧', 'F']], ['Swap task/calendar view', ['Tab']], ['Go to home', ['H']], ['Go to daily planning', ['P']], ['Go to daily task list', ['T']], ['Go to backlog', ['B']], ['Go to daily shutdown', ['O']], ['Show calendar in right panel', ['⇧', 'C']], ['Toggle dark mode', ['⇧', 'L']]]],
  ['Integrations', [['Show Gmail', ['⇧', 'G'], true], ['Show Outlook', ['⇧', 'O'], true], ['Show Asana', ['⇧', 'S'], true], ['Show Trello', ['⇧', 'E'], true], ['Show Todoist', ['⇧', 'D'], true], ['Show Jira', ['⇧', 'J'], true], ['Show Linear', ['⇧', 'V'], true], ['Show GitHub', ['⇧', 'I'], true], ['Show ClickUp', ['⇧', 'U'], true], ['Show Monday.com', ['⇧', 'M'], true], ['Show Notion', ['⇧', 'N'], true]]],
  ['Editor', [['Bold', ['⌘', 'B'], true], ['Italic', ['⌘', 'I'], true], ['Underline', ['⌘', 'U'], true], ['Strikethrough', ['⌘', 'D'], true], ['Turn text into link', ['⌘', 'K'], true], ['Undo', ['⌘', 'Z'], true], ['Redo', ['⌘', '⇧', 'Z'], true]]],
  ['Markdown formatting', [['Large header', ['#', 'Space'], true], ['Medium header', ['##', 'Space'], true], ['Bulleted list', ['-', 'Space'], true], ['Numbered list', ['1.', 'Space'], true], ['Check list', ['[ ]', 'Space'], true], ['Blockquote', ['>', 'Space'], true], ['Code block', ['```'], true], ['Inline code', ['`Code`'], true]]],
];

const SETTINGS_NAV = [
  ['Account', [['general', 'General'], ['display', 'Display'], ['rituals', 'Rituals'], ['timeboxing', 'Timeboxing'], ['schedule', 'Schedule'], ['shortcuts', 'Keyboard Shortcuts'], ['focus', 'Focus'], ['focusBar', 'Focus Bar'], ['menuBar', 'macOS Menu Bar'], ['sounds', 'Focus Sounds'], ['ai', 'AI'], ['beta', 'Beta'], ['notifications', 'Notifications'], ['profile', 'Profile'], ['account', 'Account Management']]],
  ['Workspace', [['channels', 'Projects'], ['members', 'Members'], ['privacy', 'Privacy'], ['billing', 'Billing'], ['management', 'Workspace Management']]],
  ['Integrations', [['calendar', 'Calendar'], ['email', 'Email'], ['asana', 'Asana'], ['clickup', 'ClickUp'], ['github', 'GitHub'], ['jira', 'Jira'], ['linear', 'Linear'], ['mcp', 'MCP'], ['monday', 'Monday.com'], ['notion', 'Notion'], ['todoist', 'Todoist'], ['trello', 'Trello'], ['slack', 'Slack'], ['zapier', 'Zapier'], ['toggl', 'Toggl'], ['google_tasks', 'Google Tasks']]],
];

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const save = () => persistLocalTasks(tasks);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const localDateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const minutesLabel = minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
const taskDurationLabel = task => minutesLabel(Number(task.plannedMinutes) || Number.parseInt(task.duration, 10) || 0);
const timeLabel = date => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const clockMinutes = value => {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const [hours, minutes] = String(value).split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 23) * 60 + (Number.isFinite(minutes) ? minutes : 59);
};

const colorForProject = project => projects.find(item => item.name === project)?.color || 'blue';
const readableDate = date => ({ overdue: 'Overdue', today: 'Today', tomorrow: 'Tomorrow', friday: 'Friday', upcoming: 'Upcoming', someday: 'No date' }[date] || date);

function showToast(message) {
  $('#toastText').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $('#toast').classList.remove('show'), 2200);
}

function renderOnboardingConnectors() {
  $('#connectorGrid').innerHTML = CONNECTORS.map(([id, name, color, mark]) => `
    <button class="connector-choice${onboardingSelection.has(id) ? ' selected' : ''}" data-connector="${id}" aria-pressed="${onboardingSelection.has(id)}">
      <span class="connector-mark" style="--connector-color:${color}">${mark}</span><strong>${name}</strong><span class="connector-check">✓</span>
    </button>`).join('');
  $$('[data-connector]').forEach(button => button.onclick = () => {
    const id = button.dataset.connector;
    onboardingSelection.has(id) ? onboardingSelection.delete(id) : onboardingSelection.add(id);
    renderOnboardingConnectors();
  });
  $('#continueOnboardingButton').textContent = onboardingSelection.size ? `Continue with ${onboardingSelection.size} →` : 'Continue →';
}

function renderConnectionList() {
  const hasCalendarGrant = getAuthState().hasGoogleAccess;
  $('#onboardingGoogleButton').classList.toggle('connected', hasCalendarGrant);
  $('#onboardingGoogleStatus').textContent = hasCalendarGrant ? 'Permission granted ✓' : 'Connect →';
  $('#continueCalendarButton').textContent = hasCalendarGrant ? 'Next →' : 'Skip for now →';
  $('#onboardingGoogleButton').onclick = async () => {
    const googleButton = $('#onboardingGoogleButton');
    googleButton.disabled = true;
    $('#onboardingGoogleStatus').textContent = 'Opening Google…';
    try {
      onboardingSelection.add('google_calendar');
      await saveOnboardingPreferences([...onboardingSelection], onboardingSaveOptions());
      const error = await connectGoogleCalendar();
      if (error) throw error;
    } catch (error) {
      googleButton.disabled = false;
      $('#onboardingGoogleStatus').textContent = 'Connect →';
      showToast(error.message);
    }
  };
}

function renderStartTimePresets() {
  $$('[data-start-time]').forEach(button => button.classList.toggle('selected', button.dataset.startTime === onboardingWorkdayStart));
}

function renderEndTimePresets() {
  $$('[data-end-time]').forEach(button => button.classList.toggle('selected', button.dataset.endTime === onboardingWorkdayEnd));
}

function renderPlanningRitual() {
  $$('[data-planning-ritual]').forEach(button => {
    const selected = button.dataset.planningRitual === onboardingPlanningRitual;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
}

const datePlusDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

function suggestedFirstPlanDate(now = new Date()) {
  const day = now.getDay();
  if (day === 6) return localDateKey(datePlusDays(now, 2));
  if (day === 0) return localDateKey(datePlusDays(now, 1));
  return localDateKey(onboardingPlanningRitual === 'night_before' ? datePlusDays(now, 1) : now);
}

function firstPlanDateOptions(now = new Date()) {
  const tomorrow = datePlusDays(now, 1);
  const mondayOffset = (8 - now.getDay()) % 7 || 7;
  const monday = datePlusDays(now, mondayOffset);
  return [
    { label: 'Plan today', date: now },
    { label: 'Plan tomorrow', date: tomorrow },
    { label: `Plan ${monday.toLocaleDateString('en-AU', { weekday: 'long' })}`, date: monday }
  ];
}

function renderFirstPlanDateChoices() {
  const now = new Date();
  const weekend = [0, 6].includes(now.getDay());
  $('#onboardingFirstDayLede').textContent = weekend
    ? 'Since it’s the weekend, we suggest your next Monday — but you can start sooner.'
    : 'Choose when you want to make your first focused plan. You can change this later.';
  $('#firstPlanDateChoices').innerHTML = firstPlanDateOptions(now).map(option => {
    const key = localDateKey(option.date);
    const selected = key === onboardingFirstPlanDate;
    return `<button type="button" class="routine-choice${selected ? ' selected' : ''}" data-first-plan-date="${key}" role="radio" aria-checked="${selected}"><span><strong>${option.label}</strong><small>${option.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' })}</small></span><span class="routine-check">✓</span></button>`;
  }).join('');
  $$('[data-first-plan-date]').forEach(button => button.onclick = () => {
    onboardingFirstPlanDate = button.dataset.firstPlanDate;
    renderFirstPlanDateChoices();
  });
}

const onboardingSaveOptions = (completed = false) => ({
  completed,
  workdayStart: onboardingWorkdayStart,
  workdayEnd: onboardingWorkdayEnd,
  planningRitual: onboardingPlanningRitual,
  firstPlanDate: onboardingFirstPlanDate,
  workContext: onboardingWorkContext,
  firstDayGoal: onboardingFirstDayGoal,
  automationSettings: DEFAULT_AUTOMATIONS
});

const timeMinutes = value => {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return hours * 60 + minutes;
};

function setOnboardingStep(step) {
  const calendar = step === 'calendar';
  const schedule = step === 'schedule';
  const scheduleEnd = step === 'schedule-end';
  const routine = step === 'routine';
  const firstDay = step === 'first-day';
  const workContext = step === 'work-context';
  const firstGoal = step === 'first-goal';
  const automations = step === 'automations';
  $('#onboardingToolsStep').hidden = calendar || schedule || scheduleEnd || routine || firstDay || workContext || firstGoal || automations;
  $('#onboardingConnectStep').hidden = !calendar;
  $('#onboardingTimeStep').hidden = !schedule;
  $('#onboardingEndTimeStep').hidden = !scheduleEnd;
  $('#onboardingRoutineStep').hidden = !routine;
  $('#onboardingFirstDayStep').hidden = !firstDay;
  $('#onboardingWorkContextStep').hidden = !workContext;
  $('#onboardingFirstGoalStep').hidden = !firstGoal;
  $('#onboardingAutomationStep').hidden = !automations;
  $('#onboardingGate').setAttribute('aria-labelledby', automations ? 'onboardingAutomationTitle' : firstGoal ? 'onboardingFirstGoalTitle' : workContext ? 'onboardingWorkContextTitle' : firstDay ? 'onboardingFirstDayTitle' : routine ? 'onboardingRoutineTitle' : scheduleEnd ? 'onboardingEndTimeTitle' : schedule ? 'onboardingTimeTitle' : calendar ? 'onboardingConnectTitle' : 'onboardingTitle');
  $('#onboardingProgress').textContent = `${automations ? 9 : firstGoal ? 8 : workContext ? 7 : firstDay ? 6 : routine ? 5 : scheduleEnd ? 4 : schedule ? 3 : calendar ? 2 : 1} of 9`;
  if (calendar) renderConnectionList();
  if (schedule) {
    $('#onboardingWorkdayStart').value = onboardingWorkdayStart;
    renderStartTimePresets();
  }
  if (scheduleEnd) {
    $('#onboardingWorkdayEnd').value = onboardingWorkdayEnd;
    $('#workdayWindowError').hidden = true;
    renderEndTimePresets();
  }
  if (routine) renderPlanningRitual();
  if (firstDay) renderFirstPlanDateChoices();
  if (workContext) {
    $('#onboardingWorkContext').value = onboardingWorkContext;
    updateWorkContextState();
    setTimeout(() => $('#onboardingWorkContext').focus(), 50);
  }
  if (firstGoal) {
    const planDate = new Date(`${onboardingFirstPlanDate}T12:00:00`);
    const todayKey = localDateKey(new Date());
    const tomorrowKey = localDateKey(datePlusDays(new Date(), 1));
    $('#firstGoalDayLabel').textContent = onboardingFirstPlanDate === todayKey ? 'today' : onboardingFirstPlanDate === tomorrowKey ? 'tomorrow' : `on ${planDate.toLocaleDateString('en-AU', { weekday: 'long' })}`;
    $('#onboardingFirstGoal').value = onboardingFirstDayGoal;
    updateFirstGoalState();
    setTimeout(() => $('#onboardingFirstGoal').focus(), 50);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showOnboarding(preferences = null) {
  onboardingSelection = new Set(preferences?.selected_providers || []);
  onboardingWorkdayStart = String(preferences?.workday_start || '09:00').slice(0, 5);
  onboardingWorkdayEnd = String(preferences?.workday_end || '17:00').slice(0, 5);
  onboardingPlanningRitual = preferences?.planning_ritual === 'night_before' ? 'night_before' : 'start_of_day';
  onboardingFirstPlanDate = preferences?.first_plan_date || suggestedFirstPlanDate();
  onboardingWorkContext = preferences?.work_context || '';
  onboardingFirstDayGoal = preferences?.first_day_goal || '';
  renderOnboardingConnectors();
  setOnboardingStep(onboardingSelection.has('google_calendar') ? 'calendar' : 'tools');
  $('#onboardingGate').hidden = false;
}

function closeOnboarding() {
  $('#onboardingGate').hidden = true;
  $('.app-shell').hidden = false;
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
  const todayTasks = tasks.filter(task => task.date === 'today');
  const completedToday = todayTasks.filter(task => task.status === 'done').length;
  const progress = todayTasks.length ? Math.round((completedToday / todayTasks.length) * 100) : 0;
  $('#allCount').textContent = open.length;
  $('#todayCount').textContent = open.filter(task => task.date === 'today').length;
  $('#agendaCount').textContent = `${open.filter(task => task.date === 'today').length} tasks`;
  $('#dayProgressRing').style.setProperty('--progress', progress);
  $('#dayProgressValue').innerHTML = `${completedToday}<small>/ ${todayTasks.length}</small>`;
  $('#dayProgressSummary').textContent = completedToday ? `${completedToday} task${completedToday === 1 ? '' : 's'} done` : 'No tasks completed';
  $('#dayProgressMessage').textContent = todayTasks.length ? (completedToday === todayTasks.length ? 'Today is complete' : `${todayTasks.length - completedToday} remaining`) : 'Your day is clear';
}

function renderNextUp() {
  const now = new Date();
  const today = localDateKey(now);
  const scheduledTasks = tasks
    .filter(task => task.status !== 'done' && task.scheduledAt && localDateKey(new Date(task.scheduledAt)) === today)
    .map(task => ({ type: 'task', startsAt: new Date(task.scheduledAt), title: task.title, source: task.project || 'Inbox', color: task.color }));
  const scheduledEvents = calendarEvents
    .filter(event => !event.all_day && event.starts_at && localDateKey(new Date(event.starts_at)) === today)
    .map(event => ({ type: 'event', startsAt: new Date(event.starts_at), title: event.title, source: 'Calendar', color: 'blue' }));
  const next = [...scheduledTasks, ...scheduledEvents].filter(item => item.startsAt > now).sort((a, b) => a.startsAt - b.startsAt)[0];
  if (!next) {
    $('#nextUpCard').innerHTML = '<div class="section-heading compact"><h2>Next up</h2></div><div class="next-up-empty"><strong>Your schedule is clear.</strong><p>Add a time to a task or connect your calendar.</p></div>';
    return;
  }
  const minutesAway = Math.max(1, Math.round((next.startsAt - now) / 60000));
  const countdown = minutesAway < 60 ? `In ${minutesAway} min` : `In ${Math.floor(minutesAway / 60)}h${minutesAway % 60 ? ` ${minutesAway % 60}m` : ''}`;
  const parts = next.startsAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).split(' ');
  $('#nextUpCard').innerHTML = `<div class="section-heading compact"><h2>Next up</h2><span class="live-pill"><i></i> ${escapeHtml(countdown)}</span></div><div class="next-event"><div class="event-time"><strong>${escapeHtml(parts[0])}</strong><span>${escapeHtml(parts[1] || '')}</span></div><div class="event-details"><span class="event-tag ${escapeHtml(next.color)}-bg">${escapeHtml(next.source)}</span><h3>${escapeHtml(next.title)}</h3><p>${next.type === 'event' ? 'Calendar event' : 'Scheduled task'}</p></div></div>`;
}

function preferenceTimeLabel(value) {
  const [hours = 0, minutes = 0] = String(value || '00:00').split(':').map(Number);
  const date = new Date(2000, 0, 1, hours, minutes);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderDailyRhythm() {
  $('#dailyRhythmCard').innerHTML = `<div class="section-heading compact"><h2>Daily rhythm</h2></div>
    <div class="rhythm-row"><span class="rhythm-icon">☀</span><div><strong>Daily planning</strong><small>${escapeHtml(preferenceTimeLabel(settingsPreferences.planningTime))}</small></div><button class="habit-check" data-ritual="planning" aria-label="Open daily planning">→</button></div>
    <div class="rhythm-row"><span class="rhythm-icon">◒</span><div><strong>Daily shutdown</strong><small>${escapeHtml(preferenceTimeLabel(settingsPreferences.shutdownTime))}</small></div><button class="habit-check" data-ritual="shutdown" aria-label="Open daily shutdown">→</button></div>`;
}

function renderWorkspaceInsight() {
  const completed = tasks.filter(task => task.status === 'done');
  const completedMinutes = completed.reduce((total, task) => total + (Number(task.plannedMinutes) || Number.parseInt(task.duration, 10) || 0), 0);
  $('#workspaceInsight').innerHTML = `<span class="sparkle">✦</span><div><strong>${completed.length ? `${completed.length} task${completed.length === 1 ? '' : 's'} completed` : 'No completed work yet'}</strong><p>${completed.length ? `${escapeHtml(minutesLabel(completedMinutes))} of planned work finished.` : 'Completed tasks will build your progress summary.'}</p></div>`;
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
      <div class="timeline-content"><article class="timeline-task ${task.color}-line ${task.status === 'done' ? 'completed' : ''}" data-task-detail="${task.id}">
        ${taskCheck(task)}
        <div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.project)}${task.meeting ? ' · Google Meet' : ''}</p></div>
        <span class="task-duration">${escapeHtml(taskDurationLabel(task))}</span>
      </article></div>
    </div>`).join('') + `<div class="timeline-row"><span class="time-label">+</span><div class="timeline-content"><button class="empty-slot" data-open-task>Schedule something here</button></div></div>`;
}

function renderStickyDayTimeline() {
  const hours = Array.from({ length: 13 }, (_, index) => index + 7);
  const todayTasks = tasks.filter(task => task.date === 'today' && task.status !== 'done');
  $('#stickyTimelineDate').textContent = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#stickyDayHours').innerHTML = hours.map(hour => {
    const items = todayTasks.filter(task => {
      const time = clockMinutes(task.time);
      return time >= hour * 60 && time < (hour + 1) * 60;
    });
    return `<div class="sticky-hour"><time>${String(hour).padStart(2, '0')}:00</time><div>${items.map(task => `<button type="button" data-task-detail="${task.id}" class="sticky-event ${task.color}"><strong>${escapeHtml(task.title)}</strong><span>${taskDurationLabel(task)}</span></button>`).join('')}</div></div>`;
  }).join('');
}

function focusCandidates() {
  return tasks.filter(task => task.status !== 'done').sort((a, b) => (a.date === 'today' ? -1 : 1) - (b.date === 'today' ? -1 : 1));
}

function setWorkspaceFocusSeconds(minutes) {
  focusSeconds = Math.max(1, minutes) * 60;
  const minuteText = String(Math.floor(focusSeconds / 60)).padStart(2, '0');
  $('#workspaceFocusTimer').textContent = `${minuteText}:00`;
  $('#focusSessionLabel').textContent = `Session · ${minutesLabel(minutes)}`;
}

function renderFocusWorkspace() {
  const candidates = focusCandidates();
  if (!currentFocusTaskId || !candidates.some(task => String(task.id) === String(currentFocusTaskId))) currentFocusTaskId = candidates[0]?.id || null;
  const task = candidates.find(item => String(item.id) === String(currentFocusTaskId));
  $('#focusTaskTitle').textContent = task?.title || 'Your task list is clear';
  $('#focusSubtasks').innerHTML = (task?.subtasks || []).map(subtask => `<button type="button" data-focus-subtask="${escapeHtml(subtask.id)}" class="${subtask.completed ? 'done' : ''}"><span>${subtask.completed ? '✓' : ''}</span>${escapeHtml(subtask.title)}</button>`).join('');
  $('#focusTaskPicker').innerHTML = candidates.map(item => `<button type="button" data-focus-task="${item.id}" class="${String(item.id) === String(currentFocusTaskId) ? 'active' : ''}"><i class="project-dot ${item.color}"></i><span>${escapeHtml(item.title)}</span><small>${taskDurationLabel(item)}</small></button>`).join('');
  if (!workspaceFocusRunning) setWorkspaceFocusSeconds(focusMode === 'pomodoro' ? settingsPreferences.pomodoroMinutes : (Number(task?.plannedMinutes) || Number.parseInt(task?.duration, 10) || settingsPreferences.focusMinutes));
  $$('[data-focus-mode]').forEach(button => button.classList.toggle('active', button.dataset.focusMode === focusMode));
  $('#pomodoroLengths').hidden = focusMode !== 'pomodoro';
  $$('#pomodoroLengths button').forEach(button => button.classList.toggle('active', Number(button.dataset.pomodoroMinutes) === Number(settingsPreferences.pomodoroMinutes)));
  $('#focusTimerLabel').textContent = focusMode === 'pomodoro' ? 'Pomodoro remaining' : 'Remaining';
}

function toggleWorkspaceFocusTimer() {
  workspaceFocusRunning = !workspaceFocusRunning;
  $('#workspaceFocusStart').textContent = workspaceFocusRunning ? 'Ⅱ Pause' : '▷ Resume';
  if (!workspaceFocusInterval) workspaceFocusInterval = setInterval(() => {
    if (!workspaceFocusRunning || focusSeconds <= 0) return;
    focusSeconds -= 1;
    $('#workspaceFocusTimer').textContent = `${String(Math.floor(focusSeconds / 60)).padStart(2, '0')}:${String(focusSeconds % 60).padStart(2, '0')}`;
    if (!focusSeconds) {
      workspaceFocusRunning = false;
      $('#workspaceFocusStart').textContent = 'Session complete ✓';
      showToast('Focus session complete');
    }
  }, 1000);
}

function ritualTasks(status) {
  return tasks.filter(task => status ? task.status === status : task.date === 'today');
}

function renderRitual(type = activeRitual) {
  activeRitual = type;
  const today = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  const todayKey = localDateKey(new Date());
  const completed = ritualTasks('done').filter(task => task.date === 'today' || task.dueDate === todayKey).slice(0, 6);
  const open = ritualTasks().filter(task => task.status !== 'done');
  const templates = {
    planning: `<div class="ritual-layout"><section><p class="eyebrow">Daily planning</p><h1>What do you want to get done today?</h1><p>Add tasks, set your shutdown time, then shape a realistic day.</p><div class="ritual-card"><label>Shutdown time<input type="time" id="ritualShutdownTime" value="${$('#workdayEndInput').value || '17:00'}"></label><button class="secondary-button" id="ritualOpenPlanner">Open daily planner →</button></div></section>${ritualTimeline(today, open)}</div>`,
    shutdown: `<div class="ritual-layout"><section><p class="eyebrow">Daily shutdown</p><h1>Close the loop on today.</h1><p>Capture what moved, clear loose ends, and decide what waits until tomorrow.</p><div class="ritual-card"><strong>${completed.length} completed · ${open.length} still open</strong><textarea id="shutdownReflection" placeholder="What went well today?"></textarea><button class="primary-button" id="completeShutdown">Finish my day</button></div></section>${ritualTimeline(today, completed)}</div>`,
    highlights: `<div class="ritual-layout"><section><p class="eyebrow">Daily highlights</p><h1>Review your daily highlights.</h1><p>A journal-style record generated from the work you completed.</p><button class="primary-button" id="saveHighlights">Save today’s highlights</button></section><div class="highlights-feed"><h2>${today} 😊</h2>${completed.length ? completed.map(task => `<article><i class="project-dot ${task.color}"></i><div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.project)} · ${taskDurationLabel(task)}</small></div></article>`).join('') : '<div class="ritual-empty">Complete tasks to build today’s highlights.</div>'}</div></div>`
  };
  $('#ritualContent').innerHTML = templates[type];
  $$('[data-ritual]').forEach(button => button.classList.toggle('active', button.dataset.ritual === type));
  $('#ritualOpenPlanner')?.addEventListener('click', () => openPlanner());
  $('#completeShutdown')?.addEventListener('click', event => { localStorage.setItem(`maki-shutdown:${localDateKey(new Date())}`, $('#shutdownReflection').value); event.currentTarget.textContent = 'Day closed ✓'; showToast('Daily shutdown complete'); });
  $('#saveHighlights')?.addEventListener('click', () => { localStorage.setItem(`maki-highlights:${localDateKey(new Date())}`, JSON.stringify(completed.map(task => task.id))); showToast('Daily highlights saved'); });
}

function ritualTimeline(label, items) {
  return `<aside class="ritual-timeline"><h2>${label}</h2>${items.length ? items.map(task => `<article><time>${escapeHtml(task.time || 'Anytime')}</time><div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.project)}</small></div><span>${taskDurationLabel(task)}</span></article>`).join('') : '<div class="ritual-empty">Nothing here yet.</div>'}</aside>`;
}

function renderBoard() {
  const columns = [
    { id: 'todo', label: 'To do', dot: '' },
    { id: 'progress', label: 'In progress', dot: 'progress' },
    { id: 'done', label: 'Done', dot: 'done' }
  ];
  const projectTasks = tasks.filter(task => task.project === activeProject);
  $('#boardTitle').textContent = activeProject || 'Inbox';
  $('#boardSubtitle').textContent = `${projectTasks.length} task${projectTasks.length === 1 ? '' : 's'} in this project.`;
  $('#kanbanBoard').innerHTML = columns.map(column => {
    const items = projectTasks.filter(task => task.status === column.id);
    return `<section class="kanban-column">
      <header class="column-header"><i class="status-dot ${column.dot}"></i><strong>${column.label}</strong><span>${items.length}</span><button aria-label="Column options">···</button></header>
      <div class="kanban-cards" data-status="${column.id}">${items.map(task => `<article class="kanban-card" draggable="true" data-id="${task.id}" data-task-detail="${task.id}">
        <span class="card-label">${task.project}</span><h3>${task.title}</h3>
        <div class="card-meta"><span>${readableDate(task.date)}</span><span>·</span><span>${taskDurationLabel(task)}</span>${task.priority === 'high' ? '<span class="priority">⚑ High</span>' : ''}</div>
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
  const matchesProjectScope = !projectViewScope || task.project === projectViewScope;
  return matchesProjectScope && matchesTab && matchesQuery && matchesProject && matchesPriority && matchesStatus && matchesDue;
}

function renderTasks() {
  const sourceTasks = remoteSearchResults ?? tasks;
  const filtered = sourceTasks.filter(taskMatchesFilters);
  const groups = ['overdue', 'today', 'tomorrow', 'upcoming', 'friday', 'someday'];
  $('#taskList').innerHTML = groups.map(group => {
    const items = filtered.filter(task => task.date === group);
    if (!items.length) return '';
    return `<div class="task-group"><div class="task-group-title">${readableDate(group)} · ${items.length}</div>${items.map(task => `<div class="list-task ${task.status === 'done' ? 'completed' : ''}" data-task-detail="${task.id}">
      ${taskCheck(task)}<div><strong>${task.title}</strong><small>${taskDurationLabel(task)}${task.notes ? ` · ${task.notes}` : ''}</small></div>
      <span class="task-project"><i class="project-dot ${task.color}"></i>${task.project}</span><span class="due-date ${group === 'today' && task.status !== 'done' ? 'overdue' : ''}">${task.time || '—'}</span>
    </div>`).join('')}</div>`;
  }).join('') || '<div class="empty-task-state"><span>⌕</span><strong>No matching tasks</strong><p>Try clearing a filter or searching for something else.</p><button class="secondary-button" data-clear-filters>Clear filters</button></div>';
  const availableTasks = projectViewScope ? tasks.filter(task => task.project === projectViewScope).length : tasks.length;
  $('#resultsSummary').textContent = `${filtered.length} of ${availableTasks} tasks`;
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
    return `<section class="upcoming-day"><div><h2>${day.day}</h2><span>${day.date}</span></div><div class="upcoming-tasks">${items.length ? items.map(task => `<article class="upcoming-task" data-task-detail="${task.id}">${taskCheck(task)}<div><strong>${task.title}</strong><small>${task.project} · ${taskDurationLabel(task)}</small></div><span class="due-date">${task.time}</span></article>`).join('') : '<span class="heading-subtitle">Nothing planned.</span>'}</div></section>`;
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
    days.forEach(day => {
      const events = getCalendarEvent(row, day);
      html += `<div class="cal-cell">${events}</div>`;
    });
  });
  $('#weekCalendar').innerHTML = html;
}

function getCalendarEvent(row, day) {
  const plannedTask = tasks.find(task => {
    if (!task.scheduledAt || ['done', 'archived'].includes(task.status)) return false;
    if (projectViewScope && task.project !== projectViewScope) return false;
    const startsAt = new Date(task.scheduledAt);
    return startsAt.toDateString() === day.toDateString() && startsAt.getHours() === row + 8;
  });
  if (plannedTask) {
    const startsAt = new Date(plannedTask.scheduledAt);
    return `<div class="cal-event ${plannedTask.color}-event"><strong>${escapeHtml(plannedTask.title)}</strong>${timeLabel(startsAt)} · ${escapeHtml(plannedTask.duration)}</div>`;
  }
  const remote = !projectViewScope && calendarEvents.find(event => {
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
  return '';
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
    renderNextUp();
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
      <span class="planning-task-controls">
        <select class="planning-duration-select" data-plan-duration="${escapeHtml(id)}" aria-label="Duration for ${escapeHtml(task.title)}">
          ${[5, 10, 15, 20, 25, 30, 45, 60, 90, 120].map(value => `<option value="${value}" ${value === duration ? 'selected' : ''}>${minutesLabel(value)}</option>`).join('')}
        </select>
        <select class="planning-priority-select" data-plan-priority="${escapeHtml(id)}" aria-label="Priority for ${escapeHtml(task.title)}">
          ${['high', 'medium', 'low'].map(value => `<option value="${value}" ${value === task.priority ? 'selected' : ''}>${value.charAt(0).toUpperCase() + value.slice(1)}</option>`).join('')}
        </select>
      </span>
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
  renderGuidedPlanning();
}

const GUIDED_PLAN_STEPS = ['Add a task', 'Estimate timing', 'Fill task list', 'Prioritize', 'Schedule', 'Document'];

function selectedTaskConnectors() {
  return CONNECTORS.filter(([id]) => onboardingSelection.has(id));
}

function planningDayLabel() {
  if (!planningDate) return 'your day';
  const today = localDateKey(new Date());
  const tomorrow = localDateKey(datePlusDays(new Date(), 1));
  if (planningDate === today) return 'today';
  if (planningDate === tomorrow) return 'tomorrow';
  return new Date(`${planningDate}T12:00:00`).toLocaleDateString('en-AU', { weekday: 'long' });
}

function renderPlanningDocument() {
  const section = $('#planningDocument');
  const visible = guidedPlanning && guidedPlanningStage === 6;
  section.hidden = !visible;
  if (!visible) return;
  const scheduled = planningSchedule.map(item => ({ ...item, task: tasks.find(task => String(task.id) === item.taskId) })).filter(item => item.task);
  const day = planningDayLabel();
  $('#planningDocumentSubtitle').textContent = `Document and share your plan for ${day}.`;
  $('#planningDocumentDay').textContent = `Planned for ${day}`;
  $('#planningDocumentTasks').innerHTML = scheduled.map(item => `<li><span>${escapeHtml(item.task.title)}</span><em>${minutesLabel(item.plannedMinutes)}</em></li>`).join('');
  $('#planningObstacles').value = planningObstacles;
  $('#planningDocumentPreview').innerHTML = scheduled.map(item => {
    const start = item.scheduledAt ? new Date(item.scheduledAt) : null;
    const subtasks = (item.task.subtasks || []).filter(subtask => subtask.title);
    return `<article><div><time>${start ? timeLabel(start) : '—'}</time><span>${minutesLabel(item.plannedMinutes)}</span></div><strong>${escapeHtml(item.task.title)}</strong>${subtasks.length ? `<ul>${subtasks.map(subtask => `<li>${subtask.completed ? '✓' : '○'} ${escapeHtml(subtask.title)}${subtask.plannedMinutes ? `<em>${minutesLabel(subtask.plannedMinutes)}</em>` : ''}</li>`).join('')}</ul>` : ''}<small><i class="project-dot ${item.task.color}"></i>${escapeHtml(item.task.project)}</small></article>`;
  }).join('');
}

function planningShareText() {
  const day = planningDayLabel();
  const lines = planningSchedule.map(item => {
    const task = tasks.find(candidate => String(candidate.id) === item.taskId);
    const start = item.scheduledAt ? timeLabel(new Date(item.scheduledAt)) : 'Unscheduled';
    return task ? `• ${start} — ${task.title} (${minutesLabel(item.plannedMinutes)})` : null;
  }).filter(Boolean);
  return [`My plan for ${day}`, '', ...lines, ...(planningObstacles ? ['', 'Obstacles:', planningObstacles] : [])].join('\n');
}

function setPlanningShareSwitch(button, enabled) {
  button.classList.toggle('on', enabled);
  button.setAttribute('aria-checked', String(enabled));
}

function renderPlanningShareDestinations() {
  const email = $('.profile-row small')?.textContent?.trim();
  $('#sharingEmailLabel').textContent = email || 'Email me a copy';
  setPlanningShareSwitch($('#shareToMaki'), planningShareToMaki);
  setPlanningShareSwitch($('#shareToEmail'), planningShareToEmail);
  $('#sharingAddedDestinations').innerHTML = planningExtraDestinations.map(emailAddress => `<div><span class="sharing-destination-icon email-share-icon">M</span><strong>${escapeHtml(emailAddress)}</strong><button type="button" data-remove-sharing-email="${escapeHtml(emailAddress)}" aria-label="Remove ${escapeHtml(emailAddress)}">×</button></div>`).join('');
}

function openPlanningShare() {
  planningShareToMaki = true;
  planningShareToEmail = false;
  planningExtraDestinations = [];
  $('#sharingDestinationForm').hidden = true;
  $('#sharingDestinationEmail').value = '';
  renderPlanningShareDestinations();
  $('#planningShareOverlay').hidden = false;
  setTimeout(() => $('#closePlanningShare').focus(), 30);
}

function closePlanningShare() {
  $('#planningShareOverlay').hidden = true;
  $('#sharePlanningButton').focus();
}

function renderPlanningConnectorActions() {
  const container = $('#planningConnectorActions');
  const connectors = selectedTaskConnectors();
  const visible = guidedPlanning && guidedPlanningStage === 3 && connectors.length > 0;
  container.hidden = !visible;
  if (!visible) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = connectors.map(([id, name, color, mark]) => `<button type="button" data-planning-connector="${id}"><span class="connector-mark" style="--connector-color:${color}">${escapeHtml(mark)}</span><span>Add tasks from ${escapeHtml(name)}</span><em>→</em></button>`).join('');
}

function renderGuidedPlanning() {
  const modal = $('#planningModal');
  modal.dataset.guidedStage = guidedPlanning ? String(guidedPlanningStage) : '';
  $('#planningProgress').hidden = !guidedPlanning;
  if (!guidedPlanning) {
    $('#planningNextButton').hidden = true;
    $('#commitPlanningButton').hidden = false;
    $('#commitPlanningButton').textContent = 'Commit plan';
    $('#sharePlanningButton').hidden = true;
    $('#cancelPlanningButton').textContent = 'Cancel';
    $('#planningPoolTitle').textContent = 'Choose what matters';
    renderPlanningConnectorActions();
    renderPlanningDocument();
    return;
  }
  $('#planningProgress').innerHTML = `<div><strong>Planning your first day</strong><small>Step ${guidedPlanningStage} / 6</small></div>${GUIDED_PLAN_STEPS.map((label, index) => {
    const stage = index + 1;
    const complete = stage < guidedPlanningStage;
    const active = stage === guidedPlanningStage;
    return `<button type="button" data-guided-stage="${stage}" class="${complete ? 'complete' : ''}${active ? ' active' : ''}" ${stage === 1 || stage > guidedPlanningMaxStage ? 'disabled' : ''}><span>${complete ? '✓' : stage}</span><em>${label}</em></button>`;
  }).join('')}`;
  const stageCopy = {
    2: ['Estimate timing', 'Set a realistic duration for each task.'],
    3: ['Fill in your day', 'Create new tasks, or pull in work from your selected tools.'],
    4: ['Prioritize', 'Decide what needs your best attention first.'],
    5: ['Schedule', 'Fit the work around your calendar and boundaries.'],
    6: ['Document the plan', 'Review the day you’re committing to.']
  }[guidedPlanningStage];
  $('#planningPoolTitle').textContent = stageCopy[0];
  $('#planningHint').textContent = plannerConflicts().size ? 'Resolve highlighted overlaps before continuing.' : stageCopy[1];
  $('#planningNextButton').hidden = guidedPlanningStage >= 6;
  $('#planningNextButton').textContent = guidedPlanningStage === 5 ? 'Review plan →' : 'Next →';
  $('#commitPlanningButton').hidden = guidedPlanningStage < 6;
  $('#commitPlanningButton').textContent = guidedPlanningStage === 6 ? 'Done' : 'Commit plan';
  $('#sharePlanningButton').hidden = guidedPlanningStage !== 6;
  $('#cancelPlanningButton').textContent = guidedPlanningStage === 6 ? '← Back' : 'Cancel';
  renderPlanningConnectorActions();
  renderPlanningDocument();
}

async function openPlanner(dateKey = localDateKey(new Date()), { guided = false } = {}) {
  guidedPlanning = guided;
  guidedPlanningStage = guided ? 2 : 5;
  guidedPlanningMaxStage = guidedPlanningStage;
  planningDate = dateKey;
  planningObstacles = '';
  $('#planningTitle').textContent = guided ? 'Plan your first day.' : 'Make today realistic.';
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
  planningSelected = new Set(plannerCandidates().filter(task => taskMatchesPlanDate(task, planningDate)).map(task => String(task.id)));
  planningDurations = new Map(plannerCandidates().map(task => [String(task.id), task.plannedMinutes || Number.parseInt(task.duration, 10) || 30]));
  autoArrangePlan();
  $('#planningModal').showModal();
}

function renderProjectControls() {
  const options = projects.map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('');
  $('#projectFilter').innerHTML = `<option value="all">All projects</option>${options}`;
  $('#taskProjectInput').innerHTML = '<option value="">Inbox</option>' + projects.map(project => `<option value="${escapeHtml(project.name)}">${escapeHtml(project.name)}</option>`).join('');
  $('#projectNavItems').innerHTML = projects.length ? projects.map(project => {
    const count = tasks.filter(task => task.projectId === project.id || task.project === project.name).length;
    const isActive = $('.view.active')?.dataset.view === 'board' && project.name === activeProject;
    return `<button class="nav-item ${isActive ? 'active' : ''}" data-project="${escapeHtml(project.name)}" data-view-target="board"><span class="project-dot ${escapeHtml(project.color)}"></span><span>${escapeHtml(project.name)}</span><span class="nav-count">${count}</span></button>`;
  }).join('') : '<p class="project-nav-empty">No projects yet</p>';
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

function inferTaskDefaults(title) {
  const text = title.toLowerCase().trim();
  if (!text) return null;
  let duration = 30;
  if (/\b(design|prototype|prepare|strategy|workshop)\b/.test(text)) duration = 90;
  else if (/\b(write|draft|build|create|implement)\b/.test(text)) duration = 60;
  else if (/\b(review|qa|audit|finalize|research)\b/.test(text)) duration = 45;
  else if (/\b(email|reply|book|order|call|schedule|fix)\b/.test(text)) duration = 15;

  let project = null;
  if (/\b(kitchen|house|home|repair|garden|clean|entryway|furniture)\b/.test(text)) project = 'Home';
  else if (/\b(dentist|doctor|health|personal|weekend|appointment|family)\b/.test(text)) project = 'Personal';
  else if (/\b(design|client|homepage|launch|brand|prototype|studio)\b/.test(text)) project = 'Studio relaunch';

  let date = null;
  if (/\btomorrow\b/.test(text)) date = 'tomorrow';
  else if (/\bfriday\b/.test(text)) date = 'friday';
  else if (/\btoday\b/.test(text)) date = 'today';

  return { duration, project, date, priority: /\b(urgent|asap|critical|important)\b/.test(text) ? 'high' : null };
}

function firstPlanTaskDate(dateKey) {
  const now = new Date();
  if (dateKey === localDateKey(now)) return 'today';
  if (dateKey === localDateKey(datePlusDays(now, 1))) return 'tomorrow';
  const target = new Date(`${dateKey}T12:00:00`);
  return target.getDay() === 5 ? 'friday' : 'someday';
}

function taskMatchesPlanDate(task, dateKey) {
  if (task.scheduledAt && localDateKey(new Date(task.scheduledAt)) === dateKey) return true;
  if (task.dueDate === dateKey) return true;
  const now = new Date();
  const todayKey = localDateKey(now);
  if (dateKey === todayKey && ['today', 'overdue'].includes(task.date)) return true;
  if (dateKey === localDateKey(datePlusDays(now, 1)) && task.date === 'tomorrow') return true;
  const fridayOffset = (5 - now.getDay() + 7) % 7 || 7;
  return task.date === 'friday' && dateKey === localDateKey(datePlusDays(now, fridayOffset));
}

async function seedFirstDayGoalTask() {
  const rawGoal = onboardingFirstDayGoal.trim();
  if (!rawGoal) return;
  const conciseGoal = rawGoal.split(/\n|[.!?](?:\s|$)/)[0].trim().replace(/^i\s+(?:want|need|plan)\s+to\s+/i, '');
  if (!conciseGoal) return;
  const title = `${conciseGoal.charAt(0).toUpperCase()}${conciseGoal.slice(1)}`.slice(0, 180);
  if (tasks.some(task => task.title.toLowerCase() === title.toLowerCase())) return;
  const defaults = inferTaskDefaults(title) || {};
  const project = defaults.project && projects.some(item => item.name === defaults.project) ? defaults.project : projects[0]?.name || 'Inbox';
  const plannedMinutes = defaults.duration || 30;
  const task = {
    id: crypto.randomUUID(),
    title,
    project,
    notes: 'Added from your first-day onboarding goal.',
    date: firstPlanTaskDate(onboardingFirstPlanDate),
    time: '',
    duration: `${plannedMinutes}m`,
    plannedMinutes,
    scheduledAt: new Date(`${onboardingFirstPlanDate}T${onboardingWorkdayStart}:00`).toISOString(),
    status: 'todo',
    priority: defaults.priority || 'medium',
    color: colorForProject(project)
  };
  tasks.unshift(task);
  save();
  renderAll();
  try {
    const savedTask = await createTask(task);
    tasks = tasks.map(item => item.id === task.id ? savedTask : item);
    save();
    renderAll();
  } catch {
    showToast(`Your goal is saved; task sync will retry later.`);
  }
}

function applyTaskAutomations() {
  const defaults = inferTaskDefaults($('#taskTitleInput').value);
  if (!defaults) {
    $('#smartTaskHint').textContent = '';
    return;
  }
  const applied = [];
  if (!taskAutomationTouched.has('taskDurationInput')) {
    $('#taskDurationInput').value = String(defaults.duration);
    applied.push(`${defaults.duration}m`);
  }
  if (defaults.project && !taskAutomationTouched.has('taskProjectInput') && [...$('#taskProjectInput').options].some(option => option.value === defaults.project)) {
    $('#taskProjectInput').value = defaults.project;
    applied.push(defaults.project);
  }
  if (defaults.date && !taskAutomationTouched.has('taskDateInput')) {
    $('#taskDateInput').value = defaults.date;
    applied.push(readableDate(defaults.date));
  }
  if (defaults.priority && !taskAutomationTouched.has('taskPriorityInput')) {
    $('#taskPriorityInput').value = defaults.priority;
    applied.push('High priority');
  }
  syncTaskDropdowns();
  $('#smartTaskHint').textContent = applied.length ? `Smart defaults · ${applied.join(' · ')}` : 'Your choices are locked in.';
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
  $('#projectFilter').disabled = Boolean(projectViewScope);
  $('#priorityFilter').value = activeFilters.priority;
  $('#statusFilter').value = activeFilters.status;
  $('#dueFilter').value = activeFilters.due;
}

function resetFilters() {
  const scopedProject = projects.find(project => project.name === projectViewScope);
  activeFilters = { query: '', project: scopedProject?.id || projectViewScope || 'all', priority: 'all', status: 'all', due: 'all' };
  remoteSearchResults = null;
  currentFilter = 'all';
  $$('.segmented [data-filter]').forEach(item => item.classList.toggle('active', item.dataset.filter === 'all'));
  syncFilterControls();
  renderTasks();
  bindDynamicControls();
}

function renderAll() {
  saveTrash();
  updateCounts(); renderProjectControls(); renderSavedFilters(); renderTimeline(); renderStickyDayTimeline(); renderNextUp(); renderDailyRhythm(); renderWorkspaceInsight(); renderBoard(); renderTasks(); renderUpcoming(); renderCalendar(); renderFocusWorkspace(); bindDynamicControls();
}

function bindDynamicControls() {
  $$('[data-complete]').forEach(button => button.onclick = event => { event.stopPropagation(); toggleTask(button.dataset.complete); });
  $$('[data-task-detail]').forEach(element => element.onclick = event => {
    if (event.target.closest('button,input,select,textarea,a')) return;
    openTaskDetail(element.dataset.taskDetail);
  });
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

function updateScopedViewHeadings() {
  $('#tasksEyebrow').textContent = projectViewScope ? 'Project list' : 'Everything, in one place';
  $('#tasksTitle').textContent = projectViewScope || 'All tasks';
  $('#calendarEyebrow').textContent = projectViewScope ? 'Project timeline' : 'Your time, clearly';
  $('#calendarTitle').textContent = projectViewScope || 'Calendar';
  const activeView = $('.view.active')?.dataset.view;
  $$('.project-context-tabs').forEach(tabs => {
    tabs.hidden = !projectViewScope;
    $$('[data-project-switch]', tabs).forEach(button => button.classList.toggle('active', button.dataset.projectSwitch === activeView));
  });
}

function switchProjectView(view) {
  projectViewScope = activeProject;
  const project = projects.find(item => item.name === activeProject);
  if (view === 'tasks') {
    activeFilters = { query: '', project: project?.id || activeProject, priority: 'all', status: 'all', due: 'all' };
    remoteSearchResults = null;
    currentFilter = 'all';
    $$('.segmented [data-filter]').forEach(item => item.classList.toggle('active', item.dataset.filter === 'all'));
    syncFilterControls();
  }
  updateScopedViewHeadings();
  switchView(view, null, true);
}

function switchView(view, trigger, keepProjectScope = false) {
  if (view !== 'board' && !keepProjectScope && projectViewScope) {
    projectViewScope = null;
    activeFilters.project = 'all';
    syncFilterControls();
  }
  $$('.view').forEach(section => section.classList.toggle('active', section.dataset.view === view));
  if (view !== 'ritual') $$('[data-ritual]').forEach(button => button.classList.remove('active'));
  if (view === 'board' && trigger?.dataset.project) {
    activeProject = trigger.dataset.project;
    projectViewScope = activeProject;
    $('#boardTitle').textContent = activeProject;
    renderBoard(); bindDynamicControls();
  }
  updateScopedViewHeadings();
  if (view === 'tasks') { renderTasks(); bindDynamicControls(); }
  if (view === 'calendar') renderCalendar();
  if (view === 'focus') renderFocusWorkspace();
  if (view === 'ritual') renderRitual();
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
  taskAutomationTouched = new Set();
  $('#taskDurationInput').value = '30';
  $('#smartTaskHint').textContent = '';
  const contextualProject = projectViewScope || ($('#boardView').classList.contains('active') ? activeProject : null);
  if (contextualProject && [...$('#taskProjectInput').options].some(option => option.value === contextualProject)) {
    $('#taskProjectInput').value = contextualProject;
    taskAutomationTouched.add('taskProjectInput');
  }
  syncTaskDropdowns();
  $('#taskModal').showModal();
  setTimeout(() => $('#taskTitleInput').focus(), 50);
}
function closeTaskModal() { closeTaskDropdowns(); $('#taskModal').close(); }

const priorityDetail = priority => ({
  urgent: ['Urgent', 'coral'],
  high: ['Priority', 'violet'],
  medium: ['Normal', 'muted'],
  low: ['Low priority', 'faint']
}[priority] || ['Normal', 'muted']);

function taskBucketForDueDate(dueDate) {
  if (!dueDate) return 'someday';
  const today = localDateKey(new Date());
  const tomorrow = localDateKey(datePlusDays(new Date(), 1));
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  if (dueDate === tomorrow) return 'tomorrow';
  return 'upcoming';
}

function activeDetailTask() {
  return tasks.find(task => String(task.id) === String(activeTaskDetailId));
}

async function persistTaskDetail(changes) {
  const task = activeDetailTask();
  if (!task) return;
  Object.assign(task, changes);
  save();
  renderAll();
  try { await updateTask(task.id, changes); }
  catch (error) { showToast(`Task sync paused: ${error.message}`); }
}

function closeDetailPopovers(except = null) {
  [['detailPriorityPopover', 'detailPriorityButton'], ['detailCalendarPopover', 'detailDueButton'], ['detailDurationPopover', 'taskDetailDurationButton']].forEach(([popoverId, buttonId]) => {
    if (popoverId === except) return;
    $(`#${popoverId}`).hidden = true;
    $(`#${buttonId}`).setAttribute('aria-expanded', 'false');
  });
  if (except !== 'detailDurationPopover') {
    activeDurationSubtaskId = null;
    document.querySelectorAll('[data-detail-subtask-duration]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }
}

function detailDurationLabel(minutes) {
  const value = Number(minutes) || 0;
  if (!value) return '—';
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function activeDetailDuration() {
  const task = activeDetailTask();
  if (!task) return 0;
  if (!activeDurationSubtaskId) return Number(task.plannedMinutes) || Number.parseInt(task.duration, 10) || 0;
  return Number((task.subtasks || []).find(item => item.id === activeDurationSubtaskId)?.plannedMinutes) || 0;
}

function renderDetailDurationOptions() {
  const selected = activeDetailDuration();
  $('#detailDurationCurrent').textContent = detailDurationLabel(selected);
  $('#detailDurationOptions').innerHTML = DETAIL_DURATION_OPTIONS.map(minutes => `<button type="button" role="menuitemradio" aria-checked="${selected === minutes}" data-detail-duration="${minutes}"><span>${detailDurationLabel(minutes)}</span><em>${selected === minutes ? '✓' : ''}</em></button>`).join('');
}

function openDetailDurationPopover(trigger, subtaskId = null) {
  const popover = $('#detailDurationPopover');
  const wasOpenForTarget = !popover.hidden && activeDurationSubtaskId === subtaskId;
  closeDetailPopovers(wasOpenForTarget ? null : 'detailDurationPopover');
  if (wasOpenForTarget) return;
  activeDurationSubtaskId = subtaskId;
  $('#taskDetailDurationButton').setAttribute('aria-expanded', 'false');
  document.querySelectorAll('[data-detail-subtask-duration]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  renderDetailDurationOptions();
  popover.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  const rect = trigger.getBoundingClientRect();
  const width = 218;
  const estimatedHeight = 410;
  popover.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
  popover.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - estimatedHeight - 12))}px`;
}

function renderDetailCalendar() {
  const task = activeDetailTask();
  const year = detailCalendarCursor.getFullYear();
  const month = detailCalendarCursor.getMonth();
  $('#detailCalendarMonth').textContent = detailCalendarCursor.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - startOffset);
  const todayKey = localDateKey(new Date());
  $('#detailCalendarGrid').innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = datePlusDays(start, index);
    const key = localDateKey(date);
    return `<button type="button" data-detail-date="${key}" class="${date.getMonth() !== month ? 'outside ' : ''}${key === todayKey ? 'today ' : ''}${key === task?.dueDate ? 'selected' : ''}" aria-label="${date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}">${date.getDate()}</button>`;
  }).join('');
}

function renderDetailSubtasks(task) {
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
  const completed = subtasks.filter(item => item.completed).length;
  $('#detailSubtaskProgress').textContent = `${completed} of ${subtasks.length}`;
  $('#detailSubtaskList').innerHTML = subtasks.map(subtask => `<div class="detail-subtask-row">
    <button type="button" class="subtask-check ${subtask.completed ? 'checked' : ''}" data-detail-subtask-toggle="${escapeHtml(subtask.id)}" aria-label="${subtask.completed ? 'Mark subtask incomplete' : 'Complete subtask'}">${subtask.completed ? '✓' : ''}</button>
    <input value="${escapeHtml(subtask.title)}" data-detail-subtask-title="${escapeHtml(subtask.id)}" placeholder="Subtask description…" aria-label="Subtask description" />
    <button type="button" class="subtask-duration" data-detail-subtask-duration="${escapeHtml(subtask.id)}" aria-label="Set planned time for ${escapeHtml(subtask.title || 'subtask')}" aria-haspopup="menu" aria-expanded="false">${detailDurationLabel(subtask.plannedMinutes)}</button>
    <button type="button" class="remove-subtask" data-detail-subtask-remove="${escapeHtml(subtask.id)}" aria-label="Remove subtask">×</button>
  </div>`).join('');
}

function renderTaskDetail() {
  const task = activeDetailTask();
  if (!task) return;
  $('#taskDetailTitle').value = task.title;
  $('#taskDetailNotes').value = task.notes || '';
  $('#detailProjectLabel').textContent = task.project;
  $('#detailProjectDot').className = `project-dot ${task.color}`;
  const [priorityLabel] = priorityDetail(task.priority);
  $('#detailPriorityLabel').textContent = priorityLabel;
  $('#detailPriorityButton').dataset.priority = task.priority;
  $('#detailDueLabel').textContent = task.dueDate ? new Date(`${task.dueDate}T12:00:00`).toLocaleDateString('en-AU', { month: 'short', day: 'numeric' }) : 'Due';
  const plannedMinutes = Number.isFinite(Number(task.plannedMinutes)) ? Number(task.plannedMinutes) : (Number.parseInt(task.duration, 10) || 30);
  $('#taskDetailDurationButton').textContent = detailDurationLabel(plannedMinutes);
  $('#detailCompleteButton').classList.toggle('checked', task.status === 'done');
  $('#detailCompleteButton').textContent = task.status === 'done' ? '✓' : '';
  $('#detailCompleteButton').setAttribute('aria-label', task.status === 'done' ? 'Mark task incomplete' : 'Complete task');
  $('#detailSubtasksSection').hidden = !(task.subtasks || []).length;
  renderDetailSubtasks(task);
  $('#taskDetailActivity').textContent = `${task.status === 'done' ? 'Completed' : 'Open'} · ${task.project}`;
  $('#detailPriorityPopover').innerHTML = ['urgent', 'high', 'medium', 'low'].map((value, index) => {
    const [label] = priorityDetail(value);
    return `<button type="button" role="menuitemradio" aria-checked="${task.priority === value}" data-detail-priority="${value}"><span class="priority-flag ${value}">⚑</span><strong>${label}</strong><small>${index + 1}</small><em>${task.priority === value ? '✓' : ''}</em></button>`;
  }).join('');
}

function openTaskDetail(taskId) {
  const task = tasks.find(item => String(item.id) === String(taskId));
  if (!task) return;
  activeTaskDetailId = task.id;
  detailCalendarCursor = task.dueDate ? new Date(`${task.dueDate}T12:00:00`) : new Date();
  closeDetailPopovers();
  renderTaskDetail();
  $('#taskDetailModal').showModal();
}

function closeTaskDetail() {
  closeDetailPopovers();
  activeTaskDetailId = null;
  $('#taskDetailModal').close();
}

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

function closeProfileMenu() {
  $('#profileMenu').hidden = true;
  $('#profileMenuButton').setAttribute('aria-expanded', 'false');
}

function closeWorkspaceMenu() {
  $('#workspaceMenu').hidden = true;
  $('#workspaceMenuButton').setAttribute('aria-expanded', 'false');
}

function saveTrash() {
  localStorage.setItem('maki-trash', JSON.stringify(trashedTasks));
  const count = $('#trashMenuCount');
  if (count) count.textContent = trashedTasks.length ? String(trashedTasks.length) : '';
}

function separateArchivedTasks(workspaceTasks) {
  const archived = workspaceTasks.filter(task => task.status === 'archived');
  archived.forEach(task => {
    if (!trashedTasks.some(item => String(item.task.id) === String(task.id))) trashedTasks.push({ task: { ...task, status: 'todo' }, deletedAt: new Date().toISOString() });
  });
  saveTrash();
  return workspaceTasks.filter(task => task.status !== 'archived');
}

async function moveTaskToTrash(taskId) {
  const task = tasks.find(item => String(item.id) === String(taskId));
  if (!task) return;
  tasks = tasks.filter(item => String(item.id) !== String(taskId));
  trashedTasks.unshift({ task: { ...task, status: task.status === 'archived' ? 'todo' : task.status }, deletedAt: new Date().toISOString() });
  save(); saveTrash(); renderAll(); closeTaskDetail();
  try { await updateTask(task.id, { status: 'archived' }); }
  catch (error) { showToast(`Task moved locally; sync paused: ${error.message}`); return; }
  showToast('Task moved to Trash');
}

async function restoreTrashedTask(taskId) {
  const entry = trashedTasks.find(item => String(item.task.id) === String(taskId));
  if (!entry) return;
  trashedTasks = trashedTasks.filter(item => String(item.task.id) !== String(taskId));
  tasks.unshift(entry.task); save(); saveTrash();
  try { await updateTask(entry.task.id, { status: entry.task.status || 'todo' }); }
  catch (error) { showToast(`Task restored locally; sync paused: ${error.message}`); }
  openWorkspaceUtility('trash'); renderAll(); showToast('Task restored');
}

async function permanentlyDeleteTrashedTask(taskId) {
  trashedTasks = trashedTasks.filter(item => String(item.task.id) !== String(taskId));
  saveTrash();
  try { await deleteTask(taskId); }
  catch (error) { showToast(`Couldn’t delete from sync: ${error.message}`); }
  openWorkspaceUtility('trash');
}

function shortcutPanelHtml(query = '') {
  const term = query.trim().toLowerCase();
  const groups = SHORTCUT_GROUPS.map(([name, rows]) => [name, rows.filter(([label]) => !term || `${name} ${label}`.toLowerCase().includes(term))]).filter(([, rows]) => rows.length);
  return `<div class="shortcut-search"><span>⌕</span><input id="shortcutSearch" type="search" placeholder="Search shortcuts…" value="${escapeHtml(query)}"></div><div class="shortcut-catalogue">${groups.map(([name, rows]) => `<section><h3>${name}</h3>${rows.map(([label, keys, planned]) => `<div class="shortcut-row"><span>${label}${planned ? '<small>Planned</small>' : ''}</span><span>${keys.map(key => key === 'then' || key === 'or' ? `<em>${key}</em>` : `<kbd>${escapeHtml(key)}</kbd>`).join('')}</span></div>`).join('')}</section>`).join('') || '<div class="ritual-empty">No shortcuts found.</div>'}</div>`;
}

function trashPanelHtml() {
  return `<p class="utility-lede">Tasks deleted within the past week.</p><div class="trash-list">${trashedTasks.length ? trashedTasks.map(({ task, deletedAt }) => `<article><i class="project-dot ${task.color}"></i><div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.project)} · deleted ${new Date(deletedAt).toLocaleDateString('en-AU', { weekday: 'short' })}</small></div><button type="button" data-trash-restore="${task.id}">Restore</button><button type="button" class="danger-link" data-trash-delete="${task.id}">Delete forever</button></article>`).join('') : '<div class="trash-empty"><span>⌫</span><strong>Trash is empty</strong><p>Deleted tasks stay here for seven days.</p></div>'}</div>`;
}

function settingToggle(key, title, description, disabled = false) {
  return `<label class="settings-toggle-row ${disabled ? 'disabled' : ''}"><span><strong>${title}</strong><small>${description}</small></span><input type="checkbox" data-setting="${key}" ${settingsPreferences[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}><i></i></label>`;
}

function settingSelect(key, title, description, options, disabled = false) {
  return `<label class="settings-preference-row ${disabled ? 'disabled' : ''}"><span><strong>${title}</strong><small>${description}</small></span><select data-setting="${key}" ${disabled ? 'disabled' : ''}>${options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>`;
}

function settingInput(key, title, description, type = 'text', attributes = '') {
  return `<label class="settings-preference-row"><span><strong>${title}</strong><small>${description}</small></span><input type="${type}" data-setting="${key}" value="${escapeHtml(settingsPreferences[key] ?? '')}" ${attributes}></label>`;
}

function plannedSettingsCard(title, description) {
  return `<div class="settings-planned"><span>Planned</span><strong>${title}</strong><p>${description}</p></div>`;
}

function settingsPageHtml(page) {
  const auth = getAuthState();
  const email = auth.user?.email || $('#workspaceMenuEmail').textContent || 'Local workspace';
  const fullName = $('.profile-row strong').textContent || 'Maki user';
  const connector = CONNECTORS.find(([id]) => id === page);
  const pages = {
    general: `<div class="settings-preference-list">${settingSelect('timeZone', 'Time zone', "What's your time zone?", [[Intl.DateTimeFormat().resolvedOptions().timeZone, '(GMT +10:00) Australia/Melbourne']], true)}${settingToggle('timeZoneAlert', 'Time zone alert', 'Show an alert when your time zone has changed.')}${settingSelect('timeFormat', 'Time format', 'How should times be displayed in Maki?', [['device', 'Use device region'], ['12', '12-hour'], ['24', '24-hour']])}${settingSelect('weekStart', 'Start of week', 'What day does the week start?', [['monday', 'Monday'], ['sunday', 'Sunday'], ['saturday', 'Saturday']])}${settingToggle('countPlannedAsActual', 'Count planned time as actual time', 'When a completed task has no actual time, use its planned time instead.')}${settingToggle('autoSortTasks', 'Auto-sort tasks', 'Keep your daily task list in a sensible order as plans change.')}${settingSelect('newTaskPosition', 'New task position', 'Where should newly created tasks appear?', [['top', 'Top of list'], ['bottom', 'Bottom of list']])}${settingSelect('rolloverPosition', 'Task rollover position', 'Where should unfinished tasks appear on the next day?', [['top', 'Top of list'], ['bottom', 'Bottom of list']])}${settingSelect('priorityRollover', 'Priority rollover', 'Choose whether task priority carries into the next day.', [['none', 'Keep priority'], ['lower', 'Lower by one level'], ['clear', 'Clear priority']])}${settingInput('workloadHours', 'Workload threshold', 'Warn when planned work exceeds this many hours.', 'number', 'min="1" max="16" step="0.5"')}</div>`,
    display: `<p class="settings-lede">Control how much information appears and how completed work is treated.</p><div class="settings-preference-list">${settingSelect('theme', 'Dark mode', 'Choose the appearance used across Maki.', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Use system setting']])}${settingSelect('density', 'Interface density', 'Control how much fits on screen.', [['comfortable', 'Comfortable'], ['compact', 'Compact']])}${settingSelect('calendarEventColor', 'Calendar event color', 'Choose how imported events are coloured.', [['calendar', 'Use calendar colour'], ['project', 'Use project colour'], ['neutral', 'Neutral']])}${settingToggle('hideCompletedTasks', 'Hide completed tasks in task list', 'Remove completed tasks from the daily list.')}${settingToggle('hideCompletedCalendar', 'Hide completed tasks in calendar', 'Remove completed task blocks from the timeline.')}${settingToggle('supportBubble', 'Support chat bubble', 'Show the help and feedback control in the workspace.')}${settingToggle('celebrationAnimations', 'Celebration animations', 'Celebrate meaningful progress without interrupting your flow.')}${settingToggle('spellcheck', 'Spellcheck', 'Use browser spellcheck in task notes and planning fields.')}</div>`,
    rituals: `<p class="settings-lede">Set when your planning, shutdown, and reflection rituals happen.</p><div class="settings-preference-list">${settingToggle('planningRitual', 'Daily planning', 'Shape a realistic day before starting work.')}${settingInput('planningTime', 'Daily planning time', 'When should Maki remind you to plan?', 'time')}${settingToggle('automatedPlanning', 'Automated daily planning', 'Open daily planning automatically at the chosen time.')}${settingToggle('shutdownRitual', 'Daily shutdown', 'Close loose ends and choose what moves forward.')}${settingInput('shutdownTime', 'Daily shutdown time', 'When would you like to wrap up work?', 'time')}${settingToggle('automatedShutdown', 'Automated daily shutdown', 'Open shutdown automatically near the end of your workday.')}${settingToggle('includeWeekends', 'Include weekends', 'Offer daily rituals on Saturday and Sunday.')}${settingToggle('highlightsRitual', 'Daily highlights', 'Keep a journal of work completed each day.')}${settingSelect('dailyHighlightsSchedule', 'Daily highlights delivery', 'How often should reflection prompts appear?', [['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly']])}</div>`,
    timeboxing: `<p class="settings-lede">Control how planned and actual work appears on your calendar.</p><div class="settings-preference-list">${settingToggle('taskProjections', 'Visualize projected time', 'Show planned work as time blocks on the timeline.')}${settingToggle('strongProjections', 'Strongly differentiate projections', 'Make projected blocks visually distinct from fixed events.')}${settingToggle('showActualTime', 'Visualize actual time', 'Show tracked work beside planned duration.')}${settingToggle('hidePlannedWhenComplete', 'Hide planned time for completed tasks', 'Use actual time only after a task is completed.')}${settingToggle('conflictWarnings', 'Warn about schedule conflicts', 'Flag plans that overlap meetings or leave the workday.')}${settingToggle('splitTasks', 'Allow split timeboxes', 'Break longer tasks across multiple available spaces.')}${settingSelect('calendarPrivacy', 'Timebox privacy', 'Choose the default visibility for created calendar blocks.', [['private', 'Private'], ['default', 'Calendar default'], ['public', 'Public']])}${settingInput('autoScheduleGap', 'Auto-scheduling gap', 'Minutes of breathing room between scheduled tasks.', 'number', 'min="0" max="60" step="5"')}${settingInput('defaultTaskDuration', 'Default task duration', 'Planned time assigned when no estimate exists.', 'number', 'min="5" max="480" step="5"')}${settingToggle('rescheduleConflicts', 'Auto-reschedule conflicts', 'Move flexible task blocks when calendar events conflict.')}${settingToggle('rescheduleEarlyFinish', 'Auto-reschedule after early completion', 'Pull later work forward when a task finishes early.')}</div>`,
    schedule: `<p class="settings-lede">Maki keeps planning inside these workday boundaries.</p><div class="settings-card settings-two-column"><label>Workday starts<input type="time" data-setting="workdayStart" value="${$('#workdayStartInput').value || '09:00'}"></label><label>Workday ends<input type="time" data-setting="workdayEnd" value="${$('#workdayEndInput').value || '17:00'}"></label></div>`,
    shortcuts: `<p class="settings-lede">View, search, and use every available keyboard command.</p><button class="primary-button" data-settings-open-shortcuts>Open keyboard shortcuts</button>`,
    focus: `<p class="settings-lede">Set the default timing for deep-work and Pomodoro sessions.</p><div class="settings-card settings-three-column"><label>Focus session<input type="number" min="5" max="300" step="5" data-setting="focusMinutes" value="${settingsPreferences.focusMinutes}"><small>minutes</small></label><label>Pomodoro<input type="number" min="5" max="90" step="5" data-setting="pomodoroMinutes" value="${settingsPreferences.pomodoroMinutes}"><small>minutes</small></label><label>Break<input type="number" min="1" max="30" data-setting="breakMinutes" value="${settingsPreferences.breakMinutes}"><small>minutes</small></label></div>`,
    focusBar: `<p class="settings-lede">Keep the current task and timer visible while you work.</p><div class="settings-card">${settingToggle('focusBar', 'Focus Bar', 'Show a compact floating timer inside Maki.')}</div>`,
    menuBar: plannedSettingsCard('macOS Menu Bar', 'A native macOS companion will expose the active task and timer from the menu bar.'),
    sounds: plannedSettingsCard('Focus Sounds', 'Ambient soundscapes and session chimes will arrive with the desktop app.'),
    ai: plannedSettingsCard('Maki AI', 'AI planning, estimation, summaries, and voice controls are mapped but remain disabled until the AI service is introduced.'),
    beta: `<p class="settings-lede">Try experimental workspace features before their general release.</p><div class="settings-card">${settingToggle('betaFeatures', 'Beta features', 'Receive early access to work-in-progress tools.')}</div>`,
    notifications: `<p class="settings-lede">Choose which moments deserve your attention.</p><div class="settings-card">${settingToggle('desktopNotifications', 'Desktop notifications', 'Timer completions, meeting reminders, and conflicts.')}${settingToggle('planningReminders', 'Daily planning reminder', 'Remind me near the start of my workday.')}${settingToggle('shutdownReminders', 'Daily shutdown reminder', 'Remind me before the end of my workday.')}</div>`,
    profile: `<p class="settings-lede">Your profile is visible to people who share a workspace with you.</p><div class="settings-card"><label>Display name<input data-setting="profileName" value="${escapeHtml(fullName)}"></label><label>Email<input value="${escapeHtml(email)}" disabled></label></div>`,
    account: `<p class="settings-lede">Manage this account and its local workspace data.</p><div class="settings-card"><div class="settings-action-row"><span><strong>Signed in account</strong><small>${escapeHtml(email)}</small></span><button data-settings-signout>Log out</button></div><div class="settings-action-row"><span><strong>Export workspace</strong><small>Download a JSON copy of tasks, projects, and settings.</small></span><button data-settings-export>Export</button></div></div>`,
    channels: `<p class="settings-lede">Projects organize tasks, schedules, and shared work.</p><div class="settings-card">${projects.map(project => `<div class="settings-action-row"><span><strong><i class="project-dot ${project.color}"></i>${escapeHtml(project.name)}</strong><small>${tasks.filter(task => task.project === project.name).length} tasks</small></span><button data-project="${escapeHtml(project.name)}" data-view-target="board">Open</button></div>`).join('')}</div>`,
    members: `<p class="settings-lede">People with access to this workspace.</p><div class="settings-card"><div class="member-row"><span class="avatar" aria-hidden="true"></span><span><strong>${escapeHtml(fullName)}</strong><small>${escapeHtml(email)} · Owner</small></span></div>${plannedSettingsCard('Workspace invitations', 'Team invitations and shared workspace roles are planned.')}</div>`,
    privacy: `<p class="settings-lede">Your personal task details remain private by default.</p><div class="settings-card">${settingToggle('privateByDefault', 'Private tasks by default', 'Only explicitly shared projects can be seen by other members.')}${settingToggle('hideCalendarDetails', 'Hide calendar event details', 'Show busy time without event titles in shared views.')}</div>`,
    billing: plannedSettingsCard('Billing', 'Maki is currently in private beta. Subscription and invoice controls will appear here before paid plans launch.'),
    management: `<p class="settings-lede">Workspace identity and ownership.</p><div class="settings-card"><label>Workspace name<input data-setting="workspaceName" value="Maki"></label><div class="settings-action-row danger"><span><strong>Delete workspace</strong><small>Disabled during private beta.</small></span><button disabled>Delete</button></div></div>`,
    calendar: `<p class="settings-lede">See events beside tasks and timebox work onto your real calendar.</p><div class="settings-connect-buttons"><button class="primary-button" data-settings-google-calendar>＋ Add Google Calendar</button><button disabled>＋ Add Outlook Calendar <small>Planned</small></button><button disabled>＋ Add iCloud Calendar <small>Planned</small></button></div><div class="settings-card"><div class="integration-account"><span class="connector-logo google">31</span><span><strong>${escapeHtml(email)}</strong><small>Google Calendar · ${calendarEvents.length} events loaded</small></span><button data-settings-google-calendar>${calendarSyncUserId ? 'Sync now' : 'Connect'}</button></div></div><h3 class="settings-subtitle">Meeting import</h3><div class="settings-card"><label>How meetings enter your task list<select data-setting="meetingImport"><option value="review">Review during planning</option><option value="auto">Auto-sync meetings</option><option value="off">Do not import</option></select></label>${settingToggle('meetingExclusions', 'Exclude declined, cancelled, and all-day events', 'Five sensible exclusion rules are enabled by default.')}${settingToggle('autoCompleteMeetings', 'Auto-complete imported meetings', 'Complete the task when its calendar event ends.')}</div><h3 class="settings-subtitle">Additional calendar tools</h3>${plannedSettingsCard('Zoom and Google Contacts', 'Zoom account linking and contact search are planned integrations.')}`,
    email: `<p class="settings-lede">Turn messages that require action into tasks.</p><div class="settings-connect-buttons"><button disabled>＋ Add Gmail account <small>Planned</small></button><button disabled>＋ Add Outlook account <small>Planned</small></button></div>${plannedSettingsCard('Email triage and forwarding', 'Inbox browsing, email-to-task conversion, labels, and private forwarding addresses are planned. No forwarding address is generated until the service is secure.')}`,
    mcp: plannedSettingsCard('MCP integration', 'Connect external tools through Model Context Protocol after permission and security controls are ready.'),
    slack: plannedSettingsCard('Slack', 'Turn Slack messages into Maki tasks and share daily plans to a channel.'),
    zapier: plannedSettingsCard('Zapier', 'Automation triggers and actions are planned after the public API launches.'),
    toggl: plannedSettingsCard('Toggl', 'Sync active timers and actual task duration with Toggl.'),
    google_tasks: plannedSettingsCard('Google Tasks', 'Import and complete Google Tasks from your Maki workspace.'),
  };
  if (connector && !pages[page]) {
    const connected = onboardingSelection.has(page);
    pages[page] = `<div class="connector-settings-hero"><span class="connector-logo" style="--connector:${connector[2]}">${connector[3]}</span><div><h3>${connector[1]}</h3><p>${connected ? 'Selected during onboarding. Finish authorization when this connector becomes available.' : 'Bring tasks from this service into daily planning.'}</p></div></div>${plannedSettingsCard(`${connector[1]} connector`, 'The connector is represented throughout onboarding and planning. OAuth and two-way synchronization are planned.')}<button class="secondary-button" data-settings-manage-connectors>Manage selected tools</button>`;
  }
  return pages[page] || plannedSettingsCard('Coming soon', 'This settings area is mapped and will be enabled as the underlying feature ships.');
}

function settingsConsoleHtml(page = settingsPage) {
  const label = SETTINGS_NAV.flatMap(([, items]) => items).find(([id]) => id === page)?.[1] || 'Settings';
  return `<div class="settings-console"><aside><button type="button" data-settings-return>← Return to workspace</button>${SETTINGS_NAV.map(([group, items]) => `<section><strong>${group}</strong>${items.map(([id, name]) => `<button type="button" data-settings-page="${id}" class="${id === page ? 'active' : ''}">${name}${['ai', 'beta', 'mcp'].includes(id) ? '<small>Beta</small>' : ''}</button>`).join('')}</section>`).join('')}</aside><main><div class="settings-page-title"><h2>${label}</h2><span>Learn more ↗</span></div><div id="settingsPageBody">${settingsPageHtml(page)}</div></main></div>`;
}

function saveSettingsPreference(key, value) {
  settingsPreferences[key] = value;
  localStorage.setItem('maki-settings', JSON.stringify(settingsPreferences));
}

function openSettingsConsole(page = settingsPage) {
  settingsPage = page;
  const modal = $('#workspaceUtilityModal');
  const body = $('#workspaceUtilityBody');
  modal.classList.add('settings-console-modal');
  body.oninput = null;
  body.onclick = null;
  body.innerHTML = settingsConsoleHtml(page);
  $$('[data-setting]', body).forEach(control => {
    const key = control.dataset.setting;
    if (key === 'theme') control.value = document.documentElement.dataset.theme || 'dark';
    else if (key in settingsPreferences && control.type !== 'checkbox' && !['workdayStart', 'workdayEnd', 'profileName'].includes(key)) control.value = settingsPreferences[key];
  });
  if (!modal.open) modal.showModal();
  body.onclick = async event => {
    const nav = event.target.closest('[data-settings-page]');
    if (nav) { openSettingsConsole(nav.dataset.settingsPage); return; }
    if (event.target.closest('[data-settings-return]')) { modal.close(); closeWorkspaceMenu(); return; }
    if (event.target.closest('[data-settings-open-shortcuts]')) { openWorkspaceUtility('shortcuts'); return; }
    if (event.target.closest('[data-settings-google-calendar]')) { $('#syncButton').click(); return; }
    if (event.target.closest('[data-settings-manage-connectors]')) {
      modal.close();
      try { showOnboarding(await loadOnboardingPreferences()); }
      catch (error) { showToast(`Integrations unavailable: ${error.message}`); }
      return;
    }
    if (event.target.closest('[data-settings-signout]')) { await signOut(); window.location.assign('/'); return; }
    if (event.target.closest('[data-settings-export]')) {
      const blob = new Blob([JSON.stringify({ tasks, projects, settings: settingsPreferences }, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `maki-workspace-${localDateKey(new Date())}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      showToast('Workspace export downloaded');
      return;
    }
    const openProject = event.target.closest('[data-project][data-view-target="board"]');
    if (openProject) modal.close();
  };
  const persistSettingsControl = (control, announce = true) => {
    if (!control) return;
    const key = control.dataset.setting;
    const value = control.type === 'checkbox' ? control.checked : control.type === 'number' ? Number(control.value) : control.value;
    if (key === 'theme') {
      const theme = value === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('maki-theme', theme);
      updateThemeButton(theme);
    } else if (key === 'workdayStart') $('#workdayStartInput').value = value;
    else if (key === 'workdayEnd') $('#workdayEndInput').value = value;
    else if (key === 'profileName') {
      $('.profile-row strong').textContent = value || 'Maki user';
      $('.profile-menu-details strong').textContent = value || 'Maki user';
    } else saveSettingsPreference(key, value);
    if (announce) showToast('Setting saved');
  };
  body.onchange = event => persistSettingsControl(event.target.closest('[data-setting]'));
  body.oninput = event => {
    const control = event.target.closest('[data-setting]');
    if (control && ['number', 'time', 'text'].includes(control.type)) persistSettingsControl(control, false);
  };
}

function openWorkspaceUtility(action) {
  if (action === 'settings') { openSettingsConsole('general'); return; }
  const modal = $('#workspaceUtilityModal');
  const body = $('#workspaceUtilityBody');
  modal.classList.remove('settings-console-modal');
  body.oninput = null;
  body.onclick = null;
  const completed = tasks.filter(task => task.status === 'done');
  const plannedMinutes = tasks.reduce((sum, task) => sum + (Number(task.plannedMinutes) || Number.parseInt(task.duration, 10) || 0), 0);
  const screens = {
    settings: {
      kicker: 'Workspace', title: 'Settings', html: `<div class="utility-settings"><label>Theme<select id="utilityTheme"><option value="dark">Dark</option><option value="light">Light</option></select></label><label>Workday starts<input id="utilityWorkdayStart" type="time" value="${$('#workdayStartInput').value || '09:00'}"></label><label>Workday ends<input id="utilityWorkdayEnd" type="time" value="${$('#workdayEndInput').value || '17:00'}"></label><div class="utility-actions"><button class="primary-button" id="saveWorkspaceSettings">Save settings</button></div></div>`,
    },
    analytics: {
      kicker: 'Workspace', title: 'Analytics', html: `<div class="utility-grid"><div class="utility-card big-number"><span>Tasks completed</span><strong>${completed.length}</strong><p>Across this workspace</p></div><div class="utility-card big-number"><span>Planned focus time</span><strong>${minutesLabel(plannedMinutes)}</strong><p>Across all scheduled tasks</p></div><div class="utility-card"><strong>${projects.length} projects</strong><span>${tasks.filter(task => task.status !== 'done').length} open tasks remain.</span></div><div class="utility-card"><strong>${completed.filter(task => task.date === 'today').length} done today</strong><span>Your daily highlights update as work is completed.</span></div></div>`,
    },
    shortcuts: {
      kicker: 'Resources', title: 'Keyboard shortcuts', html: shortcutPanelHtml(),
    },
    help: {
      kicker: 'Resources', title: 'Help centre', html: `<div class="utility-grid"><div class="utility-card"><strong>Plan your day</strong><span>Choose realistic work, estimate it, prioritize it, and place it on your schedule.</span></div><div class="utility-card"><strong>Connect your tools</strong><span>Import existing work through Integrations and keep Google Calendar synchronized.</span></div><div class="utility-card"><strong>Focus sessions</strong><span>Select a task, work through its subtasks, or use a timed Pomodoro session.</span></div><div class="utility-card"><strong>Need a hand?</strong><span>Send feedback from the workspace menu and include what you were trying to do.</span></div></div>`,
    },
    feedback: {
      kicker: 'Product', title: 'Request a feature', html: `<div class="utility-card"><strong>What should Maki do next?</strong><p>Tell us the workflow you want, what currently gets in the way, and what a great result would look like.</p><div class="utility-actions"><a class="primary-button" href="mailto:feedback@makiroll.xyz?subject=Maki%20feature%20request">Email the product team</a></div></div>`,
    },
    trash: {
      kicker: 'Workspace', title: 'Trash', html: trashPanelHtml(),
    },
  };
  const screen = screens[action];
  if (!screen) return;
  $('#workspaceUtilityKicker').textContent = screen.kicker;
  $('#workspaceUtilityTitle').textContent = screen.title;
  body.innerHTML = screen.html;
  if (!modal.open) modal.showModal();
  if (action === 'settings') {
    $('#utilityTheme').value = document.documentElement.dataset.theme || 'dark';
    $('#saveWorkspaceSettings').onclick = () => {
      $('#workdayStartInput').value = $('#utilityWorkdayStart').value || '09:00';
      $('#workdayEndInput').value = $('#utilityWorkdayEnd').value || '17:00';
      document.documentElement.dataset.theme = $('#utilityTheme').value;
      localStorage.setItem('maki-theme', $('#utilityTheme').value);
      updateThemeButton($('#utilityTheme').value);
      modal.close();
      showToast('Workspace settings saved');
    };
  }
  if (action === 'shortcuts') {
    $('#shortcutSearch').focus();
    body.oninput = event => {
      if (event.target.id !== 'shortcutSearch') return;
      body.innerHTML = shortcutPanelHtml(event.target.value);
      const search = $('#shortcutSearch');
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    };
  }
  if (action === 'trash') {
    body.onclick = event => {
      const restore = event.target.closest('[data-trash-restore]');
      const remove = event.target.closest('[data-trash-delete]');
      if (restore) restoreTrashedTask(restore.dataset.trashRestore);
      if (remove) permanentlyDeleteTrashedTask(remove.dataset.trashDelete);
    };
  }
}

function initTheme() {
  const stored = localStorage.getItem('maki-theme') || 'dark';
  document.documentElement.dataset.theme = stored;
  updateThemeButton(stored);
}

function initDateAndGreeting(firstName = '') {
  const now = new Date();
  $('#topbarDay').textContent = now.toLocaleDateString('en-AU', { weekday: 'long' });
  $('#topbarDate').textContent = now.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
  $('.today-heading h1').textContent = `${greeting}${firstName ? `, ${firstName}` : ''}.`;
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

document.addEventListener('click', event => {
  if (!event.target.closest('.profile-menu-wrap')) closeProfileMenu();
  if (!event.target.closest('.workspace-menu-wrap')) closeWorkspaceMenu();
  const dropdownOption = event.target.closest('[data-select-option]');
  if (dropdownOption) {
    const dropdown = dropdownOption.closest('.smart-select');
    const select = $(`#${dropdown.dataset.taskSelect}`);
    taskAutomationTouched.add(dropdown.dataset.taskSelect);
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
  const ritual = event.target.closest('[data-ritual]');
  if (ritual) { renderRitual(ritual.dataset.ritual); switchView('ritual'); }
  const switcher = event.target.closest('[data-switch]');
  if (switcher) switchProjectView(switcher.dataset.switch);
  const projectSwitcher = event.target.closest('[data-project-switch]');
  if (projectSwitcher) {
    if (projectSwitcher.dataset.projectSwitch === 'board') switchView('board', null, true);
    else switchProjectView(projectSwitcher.dataset.projectSwitch);
  }
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
$('#closeTaskDetail').onclick = closeTaskDetail;
$('#taskDetailModal').addEventListener('click', event => { if (event.target === $('#taskDetailModal')) closeTaskDetail(); });
$('#detailPriorityButton').onclick = () => {
  const popover = $('#detailPriorityPopover');
  const opening = popover.hidden;
  closeDetailPopovers(opening ? 'detailPriorityPopover' : null);
  popover.hidden = !opening;
  $('#detailPriorityButton').setAttribute('aria-expanded', String(opening));
};
$('#detailDueButton').onclick = () => {
  const popover = $('#detailCalendarPopover');
  const opening = popover.hidden;
  closeDetailPopovers(opening ? 'detailCalendarPopover' : null);
  popover.hidden = !opening;
  $('#detailDueButton').setAttribute('aria-expanded', String(opening));
  if (opening) renderDetailCalendar();
};
$('#detailPriorityPopover').onclick = async event => {
  const option = event.target.closest('[data-detail-priority]');
  if (!option) return;
  await persistTaskDetail({ priority: option.dataset.detailPriority });
  renderTaskDetail();
  closeDetailPopovers();
};
$('#detailCalendarPrev').onclick = () => { detailCalendarCursor.setMonth(detailCalendarCursor.getMonth() - 1); renderDetailCalendar(); };
$('#detailCalendarNext').onclick = () => { detailCalendarCursor.setMonth(detailCalendarCursor.getMonth() + 1); renderDetailCalendar(); };
$('#detailCalendarGrid').onclick = async event => {
  const day = event.target.closest('[data-detail-date]');
  if (!day) return;
  const dueDate = day.dataset.detailDate;
  await persistTaskDetail({ dueDate, date: taskBucketForDueDate(dueDate) });
  renderTaskDetail();
  closeDetailPopovers();
};
$('#clearDetailDueDate').onclick = async () => {
  await persistTaskDetail({ dueDate: null, date: 'someday' });
  renderTaskDetail();
  closeDetailPopovers();
};
$('#detailSubtasksButton').onclick = () => {
  $('#detailSubtasksSection').hidden = false;
  if (!(activeDetailTask()?.subtasks || []).length) $('#addDetailSubtask').click();
};
$('#detailDeleteButton').onclick = () => {
  const task = activeDetailTask();
  if (task) moveTaskToTrash(task.id);
};
$('#addDetailSubtask').onclick = async () => {
  const task = activeDetailTask();
  if (!task) return;
  const subtask = { id: crypto.randomUUID(), title: '', completed: false, plannedMinutes: 0 };
  const subtasks = [...(task.subtasks || []), subtask];
  await persistTaskDetail({ subtasks });
  $('#detailSubtasksSection').hidden = false;
  renderDetailSubtasks(activeDetailTask());
  setTimeout(() => $(`[data-detail-subtask-title="${subtask.id}"]`)?.focus(), 30);
};
$('#detailSubtaskList').addEventListener('change', async event => {
  const task = activeDetailTask();
  if (!task) return;
  const titleInput = event.target.closest('[data-detail-subtask-title]');
  if (titleInput) {
    const subtasks = (task.subtasks || []).map(item => item.id === titleInput.dataset.detailSubtaskTitle ? { ...item, title: titleInput.value.trim().slice(0, 500) } : item);
    await persistTaskDetail({ subtasks });
    renderDetailSubtasks(activeDetailTask());
  }
});
$('#detailSubtaskList').addEventListener('input', event => {
  const titleInput = event.target.closest('[data-detail-subtask-title]');
  const task = activeDetailTask();
  if (!titleInput || !task) return;
  task.subtasks = (task.subtasks || []).map(item => item.id === titleInput.dataset.detailSubtaskTitle ? { ...item, title: titleInput.value.slice(0, 500) } : item);
  save();
  clearTimeout(detailSubtaskSaveTimer);
  detailSubtaskSaveTimer = setTimeout(() => updateTask(task.id, { subtasks: task.subtasks }).catch(error => showToast(`Subtask sync paused: ${error.message}`)), 350);
});
$('#detailSubtaskList').addEventListener('click', async event => {
  const task = activeDetailTask();
  if (!task) return;
  const duration = event.target.closest('[data-detail-subtask-duration]');
  if (duration) {
    openDetailDurationPopover(duration, duration.dataset.detailSubtaskDuration);
    return;
  }
  const toggle = event.target.closest('[data-detail-subtask-toggle]');
  const remove = event.target.closest('[data-detail-subtask-remove]');
  if (!toggle && !remove) return;
  const id = toggle?.dataset.detailSubtaskToggle || remove.dataset.detailSubtaskRemove;
  const subtasks = remove ? (task.subtasks || []).filter(item => item.id !== id) : (task.subtasks || []).map(item => item.id === id ? { ...item, completed: !item.completed } : item);
  await persistTaskDetail({ subtasks });
  renderTaskDetail();
});
$('#taskDetailTitle').addEventListener('change', async event => {
  const title = event.target.value.trim();
  if (!title) { renderTaskDetail(); return; }
  await persistTaskDetail({ title });
});
$('#taskDetailNotes').addEventListener('change', event => persistTaskDetail({ notes: event.target.value.trim() }));
$('#taskDetailDurationButton').onclick = event => openDetailDurationPopover(event.currentTarget);
$('#detailDurationOptions').onclick = async event => {
  const option = event.target.closest('[data-detail-duration]');
  const task = activeDetailTask();
  if (!option || !task) return;
  const plannedMinutes = Number(option.dataset.detailDuration);
  if (activeDurationSubtaskId) {
    const subtasks = (task.subtasks || []).map(item => item.id === activeDurationSubtaskId ? { ...item, plannedMinutes } : item);
    await persistTaskDetail({ subtasks });
  } else {
    await persistTaskDetail({ plannedMinutes, duration: `${plannedMinutes}m` });
  }
  renderTaskDetail();
  closeDetailPopovers();
};
$('#clearDetailDuration').onclick = async () => {
  const task = activeDetailTask();
  if (!task) return;
  if (activeDurationSubtaskId) {
    const subtasks = (task.subtasks || []).map(item => item.id === activeDurationSubtaskId ? { ...item, plannedMinutes: 0 } : item);
    await persistTaskDetail({ subtasks });
  } else {
    await persistTaskDetail({ plannedMinutes: 0, duration: '0m' });
  }
  renderTaskDetail();
  closeDetailPopovers();
};
$('#detailCompleteButton').onclick = async () => {
  const task = activeDetailTask();
  if (!task) return;
  await toggleTask(task.id);
  renderTaskDetail();
};
$('#searchButton').onclick = openSearch;
$('#overlay').onclick = closeSearch;
$('#themeButton').onclick = toggleTheme;
$('#mobileMenu').onclick = () => $('.sidebar').classList.toggle('open');
$('#workspaceMenuButton').onclick = event => {
  event.stopPropagation();
  const menu = $('#workspaceMenu');
  const shouldOpen = menu.hidden;
  closeProfileMenu();
  closeWorkspaceMenu();
  menu.hidden = !shouldOpen;
  $('#workspaceMenuButton').setAttribute('aria-expanded', String(shouldOpen));
};
$('#workspaceMenu').onclick = async event => {
  const button = event.target.closest('[data-workspace-action]');
  if (!button) return;
  const action = button.dataset.workspaceAction;
  if (action === 'integrations') {
    openSettingsConsole('calendar');
    return;
  }
  if (action === 'desktop') { closeWorkspaceMenu(); showToast('The Maki desktop app is coming soon'); return; }
  openWorkspaceUtility(action);
};
$('#closeWorkspaceUtility').onclick = () => $('#workspaceUtilityModal').close();
$('#profileMenuButton').onclick = event => {
  event.stopPropagation();
  const menu = $('#profileMenu');
  const shouldOpen = menu.hidden;
  closeProfileMenu();
  menu.hidden = !shouldOpen;
  $('#profileMenuButton').setAttribute('aria-expanded', String(shouldOpen));
};
$('#workspaceSignOutButton').onclick = async function () {
  this.disabled = true;
  this.querySelector('span:last-child').textContent = 'Logging out…';
  await signOut();
  window.location.assign('/');
};
$('#signOutButton').onclick = async function () {
  this.disabled = true;
  this.querySelector('span').textContent = 'Signing out…';
  await signOut();
  window.location.assign('/');
};
$('#manageConnectionsButton').onclick = async () => {
  closeProfileMenu();
  try { showOnboarding(await loadOnboardingPreferences()); }
  catch (error) { showToast(`Connections unavailable: ${error.message}`); }
};
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
$('#taskTitleInput').addEventListener('input', applyTaskAutomations);
$('#focusButton').onclick = () => switchView('focus');
$('#focusClose').onclick = () => $('#focusOverlay').classList.remove('open');
$('#focusToggle').onclick = function () { focusRunning = !focusRunning; this.textContent = focusRunning ? 'Pause' : 'Resume'; };
$$('[data-focus-mode]').forEach(button => button.onclick = () => {
  focusMode = button.dataset.focusMode;
  workspaceFocusRunning = false;
  $('#workspaceFocusStart').textContent = '▷ Start';
  renderFocusWorkspace();
});
$('#focusTaskPicker').onclick = event => {
  const task = event.target.closest('[data-focus-task]');
  if (!task) return;
  currentFocusTaskId = task.dataset.focusTask;
  workspaceFocusRunning = false;
  $('#workspaceFocusStart').textContent = '▷ Start';
  renderFocusWorkspace();
};
$('#focusSubtasks').onclick = async event => {
  const subtaskButton = event.target.closest('[data-focus-subtask]');
  const task = tasks.find(item => String(item.id) === String(currentFocusTaskId));
  if (!subtaskButton || !task) return;
  const subtasks = (task.subtasks || []).map(subtask => subtask.id === subtaskButton.dataset.focusSubtask ? { ...subtask, completed: !subtask.completed } : subtask);
  task.subtasks = subtasks;
  save(); renderFocusWorkspace();
  try { await updateTask(task.id, { subtasks }); } catch (error) { showToast(`Subtask sync paused: ${error.message}`); }
};
$('#workspaceFocusStart').onclick = toggleWorkspaceFocusTimer;
$('#pomodoroLengths').onclick = event => {
  const button = event.target.closest('[data-pomodoro-minutes]');
  if (!button) return;
  workspaceFocusRunning = false;
  saveSettingsPreference('pomodoroMinutes', Number(button.dataset.pomodoroMinutes));
  $$('#pomodoroLengths button').forEach(item => item.classList.toggle('active', item === button));
  setWorkspaceFocusSeconds(Number(button.dataset.pomodoroMinutes));
  $('#workspaceFocusStart').textContent = '▷ Start';
};
$('#prevWeek').onclick = () => { weekOffset--; refreshCalendarEvents(); };
$('#nextWeek').onclick = () => { weekOffset++; refreshCalendarEvents(); };
$('#calendarTodayButton').onclick = () => { weekOffset = 0; refreshCalendarEvents(); };
$('#planDayButton').onclick = () => openPlanner();
$('#addProjectButton').onclick = () => showToast('Project creation is ready for you');

$('#closePlanningButton').onclick = () => $('#planningModal').close();
$('#cancelPlanningButton').onclick = () => {
  if (guidedPlanning && guidedPlanningStage === 6) {
    guidedPlanningStage = 5;
    renderPlanner();
    return;
  }
  $('#planningModal').close();
};
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
    return;
  }
  const priority = event.target.closest('[data-plan-priority]');
  if (priority) {
    const task = tasks.find(item => String(item.id) === priority.dataset.planPriority);
    if (!task) return;
    task.priority = priority.value;
    save();
    renderPlanner();
    updateTask(task.id, { priority: priority.value }).catch(error => showToast(`Priority sync paused: ${error.message}`));
  }
});
$('#planningProgress').addEventListener('click', event => {
  const button = event.target.closest('[data-guided-stage]');
  if (!button || button.disabled) return;
  guidedPlanningStage = Number(button.dataset.guidedStage);
  renderPlanner();
});
$('#planningNextButton').onclick = () => {
  if (!planningSelected.size) {
    showToast('Choose at least one task for this day');
    return;
  }
  if (guidedPlanningStage === 4) autoArrangePlan();
  if (guidedPlanningStage === 5 && (!planningSchedule.length || planningSchedule.some(item => !item.scheduledAt) || plannerConflicts().size)) {
    showToast('Make room for every selected task before reviewing');
    return;
  }
  guidedPlanningStage = Math.min(6, guidedPlanningStage + 1);
  guidedPlanningMaxStage = Math.max(guidedPlanningMaxStage, guidedPlanningStage);
  renderPlanner();
};
$('#planningConnectorActions').onclick = event => {
  const button = event.target.closest('[data-planning-connector]');
  if (!button) return;
  const connector = CONNECTORS.find(([id]) => id === button.dataset.planningConnector);
  if (!connector) return;
  showToast(`Connect ${connector[1]} in Integrations to import tasks.`);
};
$('#planningObstacles').addEventListener('input', event => { planningObstacles = event.target.value.slice(0, 2000); });
$('#sharePlanningButton').onclick = openPlanningShare;
$('#shareToMaki').onclick = () => {
  planningShareToMaki = !planningShareToMaki;
  setPlanningShareSwitch($('#shareToMaki'), planningShareToMaki);
};
$('#shareToEmail').onclick = () => {
  planningShareToEmail = !planningShareToEmail;
  setPlanningShareSwitch($('#shareToEmail'), planningShareToEmail);
};
$('#addSharingDestination').onclick = () => {
  const form = $('#sharingDestinationForm');
  form.hidden = !form.hidden;
  if (!form.hidden) $('#sharingDestinationEmail').focus();
};
$('#saveSharingDestination').onclick = () => {
  const input = $('#sharingDestinationEmail');
  const email = input.value.trim().toLowerCase();
  if (!input.checkValidity() || !email) {
    input.reportValidity();
    return;
  }
  if (!planningExtraDestinations.includes(email)) planningExtraDestinations.push(email);
  input.value = '';
  $('#sharingDestinationForm').hidden = true;
  renderPlanningShareDestinations();
};
$('#sharingAddedDestinations').onclick = event => {
  const remove = event.target.closest('[data-remove-sharing-email]');
  if (!remove) return;
  planningExtraDestinations = planningExtraDestinations.filter(email => email !== remove.dataset.removeSharingEmail);
  renderPlanningShareDestinations();
};
$('#planningShareOverlay').addEventListener('click', event => { if (event.target === $('#planningShareOverlay')) closePlanningShare(); });
$('#closePlanningShare').onclick = async () => {
  const text = planningShareText();
  if (planningShareToMaki) localStorage.setItem(`maki-daily-plan-note:${planningDate}`, JSON.stringify({ text, obstacles: planningObstacles, updatedAt: new Date().toISOString() }));
  const emailDestinations = [planningShareToEmail, planningExtraDestinations.length].some(Boolean);
  if (emailDestinations) {
    try { await navigator.clipboard.writeText(text); }
    catch { /* The saved Maki copy remains available if clipboard access is blocked. */ }
  }
  closePlanningShare();
  showToast(planningShareToMaki && emailDestinations ? 'Plan saved · email copy prepared' : planningShareToMaki ? 'Plan saved to Maki' : emailDestinations ? 'Email copy prepared' : 'Sharing destinations updated');
};
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
    button.textContent = guidedPlanning && guidedPlanningStage === 6 ? 'Done' : 'Commit plan';
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
  const project = $('#taskProjectInput').value || 'Inbox';
  const task = {
    id: crypto.randomUUID(), title, project, notes: $('#taskNotesInput').value.trim(), date: $('#taskDateInput').value,
    time: '', duration: `${$('#taskDurationInput').value}m`, plannedMinutes: Number($('#taskDurationInput').value), status: 'todo',
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

document.addEventListener('keydown', async event => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (command && event.key === 'Enter' && $('#taskModal').open) $('#taskForm').requestSubmit();
  if (command && event.shiftKey && key === 'a') { event.preventDefault(); openTaskModal(); return; }
  if (!typing && ['a', 'n'].includes(key) && !$('#taskModal').open && !$('#taskDetailModal').open) { event.preventDefault(); openTaskModal(); return; }
  if (command && key === 'k') { event.preventDefault(); openSearch(); return; }
  if (!typing && event.key === '?') { event.preventDefault(); openWorkspaceUtility('shortcuts'); return; }
  if (!typing && event.shiftKey && key === 'l') { event.preventDefault(); toggleTheme(); return; }
  if (!typing && command && event.shiftKey && event.code === 'Space') { event.preventDefault(); toggleWorkspaceFocusTimer(); return; }
  if (!typing && event.shiftKey && event.code === 'Space') { event.preventDefault(); switchView('today'); return; }
  if (!typing && event.shiftKey && key === 'f') { event.preventDefault(); switchView('tasks'); $('#filterPanel').hidden = false; return; }
  if (!typing && event.shiftKey && key === 'c') { event.preventDefault(); switchView('calendar'); return; }
  if (!typing && key === 'f') { event.preventDefault(); switchView('focus'); return; }
  if (!typing && key === 'p') { event.preventDefault(); renderRitual('planning'); switchView('ritual'); return; }
  if (!typing && key === 'o') { event.preventDefault(); renderRitual('shutdown'); switchView('ritual'); return; }
  if (!typing && key === 't') { event.preventDefault(); switchView('tasks'); return; }
  if (!typing && key === 'h') { event.preventDefault(); switchView('today'); return; }
  if (!typing && key === 'b') { event.preventDefault(); resetFilters(); activeFilters = { ...activeFilters, due: 'unscheduled', status: 'open' }; syncFilterControls(); switchView('tasks'); renderTasks(); return; }
  if (!typing && !$('#focusView').hidden && event.code === 'Space') { event.preventDefault(); toggleWorkspaceFocusTimer(); return; }
  if (!typing && !$('#focusView').hidden && key === 'k') { event.preventDefault(); workspaceFocusRunning = false; focusMode = 'pomodoro'; setWorkspaceFocusSeconds(5); renderFocusWorkspace(); showToast('Five-minute break ready'); return; }
  const detailTask = activeDetailTask();
  if (!typing && detailTask && $('#taskDetailModal').open) {
    if (command && event.key === 'Backspace') { event.preventDefault(); await moveTaskToTrash(detailTask.id); return; }
    if (command && key === 'd') { event.preventDefault(); const copy = { ...detailTask, id: crypto.randomUUID(), title: `${detailTask.title} copy`, status: 'todo', subtasks: (detailTask.subtasks || []).map(item => ({ ...item, id: crypto.randomUUID() })) }; tasks.unshift(copy); save(); renderAll(); try { await createTask(copy); } catch (error) { showToast(`Duplicate saved locally: ${error.message}`); } showToast('Task duplicated'); return; }
    if (key === 'c') { event.preventDefault(); $('#detailCompleteButton').click(); return; }
    if (key === 'v') { event.preventDefault(); $('#detailSubtasksButton').click(); return; }
    if (key === 'w' || event.key === '~') { event.preventDefault(); $('#taskDetailDurationButton').click(); return; }
    if (event.key === '!') { event.preventDefault(); await persistTaskDetail({ priority: 'high' }); renderTaskDetail(); return; }
    if (event.key === '@') { event.preventDefault(); $('#detailDueButton').click(); return; }
    if (key === 's') { event.preventDefault(); await persistTaskDetail({ date: 'today', dueDate: localDateKey(new Date()) }); renderTaskDetail(); return; }
    if (key === 'd') { event.preventDefault(); const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); await persistTaskDetail({ date: 'tomorrow', dueDate: localDateKey(tomorrow) }); renderTaskDetail(); return; }
    if (key === 'z') { event.preventDefault(); await persistTaskDetail({ date: 'someday', dueDate: null, time: '' }); renderTaskDetail(); return; }
  }
  if (event.key === 'Escape') { closeProfileMenu(); closeWorkspaceMenu(); closeTaskDropdowns(); closeSearch(); $('.sidebar').classList.remove('open'); }
});

$('.notification-button').onclick = () => showToast('You’re all caught up');
$$('.habit-check').forEach(button => button.onclick = () => { button.classList.toggle('done'); button.textContent = button.classList.contains('done') ? '✓' : ''; });

$('#continueOnboardingButton').onclick = async () => {
  try { await saveOnboardingPreferences([...onboardingSelection], onboardingSaveOptions()); setOnboardingStep('calendar'); }
  catch (error) { showToast(`Couldn’t save setup: ${error.message}`); }
};
$('#backOnboardingButton').onclick = () => setOnboardingStep('tools');
$('#continueCalendarButton').onclick = () => setOnboardingStep('schedule');
$('#backToCalendarButton').onclick = () => setOnboardingStep('calendar');
$('#continueWorkdayStartButton').onclick = () => {
  onboardingWorkdayStart = $('#onboardingWorkdayStart').value || '09:00';
  if (timeMinutes(onboardingWorkdayEnd) <= timeMinutes(onboardingWorkdayStart)) {
    const suggested = Math.min(timeMinutes(onboardingWorkdayStart) + 8 * 60, 23 * 60 + 45);
    onboardingWorkdayEnd = `${String(Math.floor(suggested / 60)).padStart(2, '0')}:${String(suggested % 60).padStart(2, '0')}`;
  }
  setOnboardingStep('schedule-end');
};
$('#backToStartTimeButton').onclick = () => setOnboardingStep('schedule');
$('#continueWorkdayEndButton').onclick = () => {
  onboardingWorkdayEnd = $('#onboardingWorkdayEnd').value || '17:00';
  if (timeMinutes(onboardingWorkdayEnd) <= timeMinutes(onboardingWorkdayStart)) {
    $('#workdayWindowError').hidden = false;
    $('#onboardingWorkdayEnd').focus();
    return;
  }
  setOnboardingStep('routine');
};
$('#backToEndTimeButton').onclick = () => setOnboardingStep('schedule-end');
$$('[data-start-time]').forEach(button => button.onclick = () => {
  onboardingWorkdayStart = button.dataset.startTime;
  $('#onboardingWorkdayStart').value = onboardingWorkdayStart;
  renderStartTimePresets();
});
$('#onboardingWorkdayStart').addEventListener('change', event => {
  onboardingWorkdayStart = event.target.value || '09:00';
  renderStartTimePresets();
});
$$('[data-end-time]').forEach(button => button.onclick = () => {
  onboardingWorkdayEnd = button.dataset.endTime;
  $('#onboardingWorkdayEnd').value = onboardingWorkdayEnd;
  $('#workdayWindowError').hidden = true;
  renderEndTimePresets();
});
$('#onboardingWorkdayEnd').addEventListener('change', event => {
  onboardingWorkdayEnd = event.target.value || '17:00';
  $('#workdayWindowError').hidden = true;
  renderEndTimePresets();
});
$$('[data-planning-ritual]').forEach(button => button.onclick = () => {
  onboardingPlanningRitual = button.dataset.planningRitual;
  onboardingFirstPlanDate = suggestedFirstPlanDate();
  renderPlanningRitual();
});
$('#continueRoutineButton').onclick = () => setOnboardingStep('first-day');
$('#backToRoutineButton').onclick = () => setOnboardingStep('routine');
$('#continueFirstDayButton').onclick = async () => {
  try {
    await saveOnboardingPreferences([...onboardingSelection], onboardingSaveOptions());
    setOnboardingStep('work-context');
  } catch (error) { showToast(`Couldn’t save setup: ${error.message}`); }
};
$('#backToFirstDayButton').onclick = () => setOnboardingStep('first-day');
function updateWorkContextState() {
  const value = $('#onboardingWorkContext').value;
  $('#workContextCount').textContent = `${value.length} / 2000`;
  $('#continueWorkContextButton').disabled = !value.trim();
}
$('#onboardingWorkContext').addEventListener('input', event => {
  onboardingWorkContext = event.target.value;
  updateWorkContextState();
});
$('#continueWorkContextButton').onclick = async () => {
  onboardingWorkContext = $('#onboardingWorkContext').value.trim();
  if (!onboardingWorkContext) return;
  try {
    await saveOnboardingPreferences([...onboardingSelection], onboardingSaveOptions());
    setOnboardingStep('first-goal');
  } catch (error) { showToast(`Couldn’t save setup: ${error.message}`); }
};
$('#backToWorkContextButton').onclick = () => setOnboardingStep('work-context');
function updateFirstGoalState() {
  const value = $('#onboardingFirstGoal').value;
  $('#firstGoalCount').textContent = `${value.length} / 2000`;
  $('#continueFirstGoalButton').disabled = !value.trim();
}
$('#onboardingFirstGoal').addEventListener('input', event => {
  onboardingFirstDayGoal = event.target.value;
  updateFirstGoalState();
});
$('#continueFirstGoalButton').onclick = async () => {
  onboardingFirstDayGoal = $('#onboardingFirstGoal').value.trim();
  if (!onboardingFirstDayGoal) return;
  try {
    await saveOnboardingPreferences([...onboardingSelection], onboardingSaveOptions());
    setOnboardingStep('automations');
  } catch (error) { showToast(`Couldn’t save setup: ${error.message}`); }
};
$('#backToFirstGoalButton').onclick = () => setOnboardingStep('first-goal');
$('#skipOnboardingButton').onclick = async () => {
  try {
    await saveOnboardingPreferences([...onboardingSelection], onboardingSaveOptions());
    setOnboardingStep('calendar');
  }
  catch (error) { showToast(`Couldn’t save setup: ${error.message}`); }
};
$('#finishOnboardingButton').onclick = async () => {
  onboardingWorkdayStart = $('#onboardingWorkdayStart').value || '09:00';
  onboardingWorkdayEnd = $('#onboardingWorkdayEnd').value || '17:00';
  if (timeMinutes(onboardingWorkdayEnd) <= timeMinutes(onboardingWorkdayStart)) {
    $('#workdayWindowError').hidden = false;
    $('#onboardingWorkdayEnd').focus();
    return;
  }
  try {
    await saveOnboardingPreferences([...onboardingSelection], onboardingSaveOptions(true));
    $('#workdayStartInput').value = onboardingWorkdayStart;
    $('#workdayEndInput').value = onboardingWorkdayEnd;
    closeOnboarding();
    showToast('Your workspace is ready');
    await seedFirstDayGoalTask();
    await openPlanner(onboardingFirstPlanDate || localDateKey(new Date()), { guided: true });
  }
  catch (error) { showToast(`Couldn’t finish setup: ${error.message}`); }
};

initTheme();
initDateAndGreeting();
renderAll();

let landingMotionReady = false;
function initLandingMotion() {
  if (landingMotionReady) return;
  landingMotionReady = true;
  const landing = $('#authGate');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  landing.classList.add('motion-ready');

  const revealTargets = [
    $('.landing-proof'),
    $('.story-heading'),
    ...$$('.story-steps article'),
    ...$$('.feature-card'),
    $('.signup-copy'),
    $('.landing .auth-card'),
    $('.landing-footer')
  ].filter(Boolean);
  revealTargets.forEach(target => target.classList.add('landing-reveal'));

  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealTargets.forEach(target => target.classList.add('is-visible'));
    landing.classList.add('landing-mounted');
    return;
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { root: landing, threshold: .14, rootMargin: '0px 0px -7% 0px' });
  revealTargets.forEach(target => observer.observe(target));

  const scene = $('.product-scene');
  if (scene && window.matchMedia('(pointer:fine)').matches) {
    scene.addEventListener('pointermove', event => {
      const bounds = scene.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - .5;
      const y = (event.clientY - bounds.top) / bounds.height - .5;
      scene.style.setProperty('--scene-x', `${x * 2.4}deg`);
      scene.style.setProperty('--scene-y', `${y * -2}deg`);
      scene.style.setProperty('--scene-lift', '-3px');
    });
    scene.addEventListener('pointerleave', () => {
      scene.style.removeProperty('--scene-x');
      scene.style.removeProperty('--scene-y');
      scene.style.removeProperty('--scene-lift');
    });
  }

  requestAnimationFrame(() => requestAnimationFrame(() => landing.classList.add('landing-mounted')));
}

async function hydratePersistence(user) {
  const key = user?.id || 'local';
  if (hydratedUserId === key) return { ready: true, isEmpty: tasks.length === 0 && projects.length === 0 };
  hydratedUserId = null;
  stopWorkspaceSubscription();
  stopWorkspaceSubscription = () => {};
  tasks = [];
  projects = [];
  savedFilters = [];
  persistenceMode = 'loading';
  try {
    const workspace = await loadWorkspace();
    if (user && workspace.mode !== 'remote') throw new Error('Authenticated workspace unavailable');
    tasks = separateArchivedTasks(workspace.tasks);
    projects = workspace.projects;
    savedFilters = workspace.savedFilters;
    persistenceMode = workspace.mode;
    hydratedUserId = key;
    activeProject = projects[0]?.name || 'Inbox';
    renderAll();
    if (user && workspace.mode === 'remote') {
      stopWorkspaceSubscription = subscribeToWorkspace(user.id, async () => {
        try {
          const refreshed = await loadWorkspace();
          tasks = separateArchivedTasks(refreshed.tasks); projects = refreshed.projects; savedFilters = refreshed.savedFilters;
          renderAll();
        } catch (error) {
          showToast(`Sync paused: ${error.message}`);
        }
      });
    }
    return { ready: true, isEmpty: workspace.isEmpty };
  } catch (error) {
    tasks = [];
    projects = [];
    savedFilters = [];
    persistenceMode = 'locked';
    hydratedUserId = null;
    renderAll();
    showToast(`Database unavailable: ${error.message}`);
    return { ready: false, isEmpty: false };
  }
}

$('#googleSignInButton').onclick = async () => {
  if (getAuthState().user) {
    window.location.assign('/app');
    return;
  }
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
    let workspaceRoute = window.location.pathname === '/app';
    if (workspaceRoute && !user) {
      window.history.replaceState({}, document.title, '/');
      workspaceRoute = false;
    }
    $('#authGate').hidden = false;
    $('.app-shell').hidden = true;
    if (!workspaceRoute) initLandingMotion();
    if (error) $('#authStatus').textContent = error.message;
    if (!configured) {
      $('#authStatus').textContent = 'Maki is temporarily unavailable because its sign-in service is not configured.';
      $('#googleSignInButton').disabled = true;
      $('#magicLinkForm button').disabled = true;
    }
    if (!user) {
      stopWorkspaceSubscription();
      stopWorkspaceSubscription = () => {};
      stopCalendarSync();
      calendarSyncUserId = null;
      calendarEvents = [];
      hydratedUserId = null;
      tasks = [];
      projects = [];
      savedFilters = [];
      $('#googleSignInButton').textContent = configured ? 'Continue with Google' : 'Sign-in unavailable';
      $('.auth-divider').hidden = false;
      $('#magicLinkForm').hidden = false;
      return;
    }
    persistLocalTasks([]);
    const metadata = user.user_metadata || {};
    const fullName = metadata.full_name || metadata.name || user.email?.split('@')[0] || 'Maki user';
    $('#authTitle').textContent = `Welcome back, ${fullName.split(' ')[0]}.`;
    $('#googleSignInButton').textContent = 'Open Maki';
    $('.auth-divider').hidden = true;
    $('#magicLinkForm').hidden = true;
    if (!workspaceRoute) return;
    $('.profile-row strong').textContent = fullName;
    $('.profile-row small').textContent = user.email || '';
    $('.profile-menu-details strong').textContent = fullName;
    $('.profile-menu-details small').textContent = user.email || '';
    $('#workspaceMenuEmail').textContent = user.email || fullName;
    initDateAndGreeting(fullName.split(' ')[0]);
    renderProfileAvatar(user, fullName);
    const workspaceState = await hydratePersistence(user);
    if (!workspaceState.ready) {
      $('#authTitle').textContent = 'We couldn’t open your workspace.';
      $('#authStatus').textContent = 'Your data stayed private. Refresh to try again.';
      return;
    }
    try {
      const onboarding = await loadOnboardingPreferences();
      onboardingSelection = new Set(onboarding?.selected_providers || []);
      if (onboarding?.workday_start) $('#workdayStartInput').value = String(onboarding.workday_start).slice(0, 5);
      if (onboarding?.workday_end) $('#workdayEndInput').value = String(onboarding.workday_end).slice(0, 5);
      if (workspaceState.isEmpty || !onboarding?.completed_at) {
        $('#authGate').hidden = true;
        $('.app-shell').hidden = true;
        showOnboarding(onboarding);
      } else {
        $('#authGate').hidden = true;
        $('.app-shell').hidden = false;
      }
    } catch (onboardingError) {
      $('#authGate').hidden = false;
      $('.app-shell').hidden = true;
      $('#authTitle').textContent = 'We couldn’t finish loading your setup.';
      $('#authStatus').textContent = 'Your data stayed private. Refresh to try again.';
      console.error('Onboarding load failed', onboardingError);
    }
    if (providerToken) {
      try {
        await saveGoogleGrant(providerToken, providerRefreshToken);
        completeGoogleCalendarConsent();
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
