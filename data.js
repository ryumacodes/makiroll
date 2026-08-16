import { getAuthState, getSupabaseClient } from './supabase.js';

const LOCAL_TASKS_KEY = 'maki-tasks';
const LOCAL_PROJECTS_KEY = 'maki-projects';
const LOCAL_FILTERS_KEY = 'maki-saved-filters';
const LOCAL_PLANS_KEY = 'maki-daily-plans';
const LOCAL_ONBOARDING_KEY = 'maki-onboarding';
const LOCAL_TASK_EXTRAS_KEY = 'maki-task-extras';
const LEGACY_DEMO_TASK_TITLES = new Set([
  'Homepage visual QA',
  'Homepage critique',
  'Write launch email draft',
  'Book dentist appointment',
  'Finalize type scale',
  'Order entryway bench',
  'Prepare client handoff',
  'Weekly review',
  'Mobile navigation prototype',
  'Archive old project files',
  'Fix loose kitchen handle',
  'Plan winter weekend'
]);
const LEGACY_DEMO_PROJECT_NAMES = new Set(['Studio relaunch', 'Home', 'Personal']);
let projects = [];
let savedFilters = [];
let realtimeChannel = null;

const localDate = date => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addDays = (date, amount) => {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
};

const dateForLegacyBucket = bucket => {
  const today = new Date();
  if (bucket === 'today') return localDate(today);
  if (bucket === 'tomorrow') return localDate(addDays(today, 1));
  if (bucket === 'friday') {
    const distance = ((5 - today.getDay() + 7) % 7) || 7;
    return localDate(addDays(today, distance));
  }
  return null;
};

const bucketForDate = dueDate => {
  if (!dueDate) return 'someday';
  const today = localDate(new Date());
  const tomorrow = localDate(addDays(new Date(), 1));
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  if (dueDate === tomorrow) return 'tomorrow';
  return 'upcoming';
};

const scheduledAtForTask = (dueDate, time) => {
  if (!dueDate || !time) return null;
  const [hourText, minuteText = '0'] = time.split(':');
  let hour = Number(hourText);
  if (hour > 0 && hour < 7) hour += 12;
  const date = new Date(`${dueDate}T00:00:00`);
  date.setHours(hour, Number(minuteText), 0, 0);
  return date.toISOString();
};

const formatTime = scheduledAt => {
  if (!scheduledAt) return '';
  const date = new Date(scheduledAt);
  const hour = date.getHours() % 12 || 12;
  return `${hour}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const taskExtras = () => {
  const userId = getAuthState().user?.id || 'local';
  return JSON.parse(localStorage.getItem(`${LOCAL_TASK_EXTRAS_KEY}:${userId}`) || '{}');
};

const saveTaskExtra = (taskId, changes) => {
  const userId = getAuthState().user?.id || 'local';
  const key = `${LOCAL_TASK_EXTRAS_KEY}:${userId}`;
  const extras = JSON.parse(localStorage.getItem(key) || '{}');
  extras[taskId] = { ...(extras[taskId] || {}), ...changes };
  localStorage.setItem(key, JSON.stringify(extras));
};

const normaliseTask = row => {
  const project = row.project || projects.find(item => item.id === row.project_id);
  const extras = taskExtras()[row.id] || {};
  return ({
  id: row.id,
  title: row.title,
  notes: row.notes || '',
  projectId: row.project_id || null,
  project: project?.name || 'Inbox',
  color: project?.color || 'violet',
  date: bucketForDate(row.due_date),
  dueDate: row.due_date,
  time: formatTime(row.scheduled_at),
  scheduledAt: row.scheduled_at,
  duration: `${row.planned_minutes || 0}m`,
  plannedMinutes: row.planned_minutes || 0,
  status: row.status,
  priority: row.priority,
  completedAt: row.completed_at,
  position: row.position || 0,
  subtasks: Array.isArray(row.subtasks) ? row.subtasks : (extras.subtasks || [])
  });
};

const taskToRow = (task, projectId) => {
  const dueDate = task.dueDate ?? dateForLegacyBucket(task.date);
  return {
    project_id: projectId || task.projectId || null,
    title: task.title,
    notes: task.notes || '',
    status: task.status || 'todo',
    priority: task.priority || 'medium',
    due_date: dueDate,
    scheduled_at: task.scheduledAt || scheduledAtForTask(dueDate, task.time),
    planned_minutes: task.plannedMinutes ?? (Number.parseInt(task.duration, 10) || 30),
    position: task.position || Date.now(),
    completed_at: task.status === 'done' ? (task.completedAt || new Date().toISOString()) : null
  };
};

function localWorkspace() {
  const localTasks = JSON.parse(localStorage.getItem(LOCAL_TASKS_KEY) || '[]');
  projects = JSON.parse(localStorage.getItem(LOCAL_PROJECTS_KEY) || '[]');
  savedFilters = JSON.parse(localStorage.getItem(LOCAL_FILTERS_KEY) || '[]');
  return { mode: 'local', tasks: localTasks, projects, savedFilters, isEmpty: localTasks.length === 0 && projects.length === 0 };
}

export async function createProject({ name, color = 'coral' }) {
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) throw new Error('Project name is required.');
  if (projects.some(project => project.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
    throw new Error('A project with this name already exists.');
  }
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) {
    const project = { id: crypto.randomUUID(), name: cleanName, color, position: projects.length };
    projects = [...projects, project];
    localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(projects));
    return project;
  }
  const { data, error } = await client.from('projects')
    .insert({ user_id: user.id, name: cleanName, color, position: projects.length })
    .select('id,name,color,position')
    .single();
  if (error) throw error;
  projects = [...projects, data];
  return data;
}

function withoutLegacyDemoData(taskRows, projectRows) {
  const demoTasks = taskRows.filter(task => LEGACY_DEMO_TASK_TITLES.has(task.title));
  const demoProjects = projectRows.filter(project => LEGACY_DEMO_PROJECT_NAMES.has(project.name));
  const hasCompleteDemoSignature = demoTasks.length === LEGACY_DEMO_TASK_TITLES.size
    && new Set(demoTasks.map(task => task.title)).size === LEGACY_DEMO_TASK_TITLES.size
    && demoProjects.length === LEGACY_DEMO_PROJECT_NAMES.size
    && new Set(demoProjects.map(project => project.name)).size === LEGACY_DEMO_PROJECT_NAMES.size;

  if (!hasCompleteDemoSignature) return { taskRows, projectRows };
  return {
    taskRows: taskRows.filter(task => !LEGACY_DEMO_TASK_TITLES.has(task.title)),
    projectRows: projectRows.filter(project => !LEGACY_DEMO_PROJECT_NAMES.has(project.name))
  };
}

export async function loadWorkspace() {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) return localWorkspace();

  // Synced workspaces never share task caches through browser localStorage.
  localStorage.removeItem(LOCAL_TASKS_KEY);
  localStorage.removeItem(LOCAL_FILTERS_KEY);
  localStorage.removeItem(LOCAL_PLANS_KEY);

  const { data: projectRows, error: projectError } = await client
    .from('projects')
    .select('id,name,color,position')
    .eq('user_id', user.id)
    .is('archived_at', null)
    .order('position');
  if (projectError) throw projectError;
  const remoteProjects = projectRows || [];

  const { data: taskRows, error: taskError } = await client
    .from('tasks')
    .select('*,project:projects(id,name,color)')
    .eq('user_id', user.id)
    .neq('status', 'archived')
    .order('position');
  if (taskError) throw taskError;

  const realWorkspace = withoutLegacyDemoData(taskRows || [], remoteProjects);
  projects = realWorkspace.projectRows;

  const { data: filterRows, error: filterError } = await client.from('saved_filters').select('*').eq('user_id', user.id).order('position');
  if (filterError) throw filterError;
  savedFilters = filterRows || [];

  return {
    mode: 'remote',
    tasks: realWorkspace.taskRows.map(normaliseTask),
    projects,
    savedFilters,
    isEmpty: realWorkspace.taskRows.length === 0 && projects.length === 0
  };
}

export async function loadOnboardingPreferences() {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) return JSON.parse(localStorage.getItem(LOCAL_ONBOARDING_KEY) || 'null');
  const fields = 'selected_providers,workday_start,workday_end,planning_ritual,first_plan_date,work_context,first_day_goal,automation_settings,completed_at';
  let { data, error } = await client.from('onboarding_preferences').select(fields).eq('user_id', user.id).maybeSingle();
  if (error && ['PGRST204', '42703'].includes(error.code)) {
    ({ data, error } = await client.from('onboarding_preferences')
      .select('selected_providers,workday_start,workday_end,planning_ritual,completed_at').eq('user_id', user.id).maybeSingle());
    data = { ...(data || {}), ...(JSON.parse(localStorage.getItem(LOCAL_ONBOARDING_KEY) || 'null') || {}) };
  }
  if (error) throw error;
  return data;
}

export async function saveOnboardingPreferences(selectedProviders, {
  completed = false,
  workdayStart = '09:00',
  workdayEnd = '17:00',
  planningRitual = 'start_of_day',
  firstPlanDate = null,
  workContext = '',
  firstDayGoal = '',
  automationSettings = { conflict_aware_planning: true, workday_boundaries: true, duration_suggestions: true, project_suggestions: true }
} = {}) {
  const providers = [...new Set(selectedProviders)].slice(0, 24);
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  const preferences = {
    selected_providers: providers,
    workday_start: workdayStart,
    workday_end: workdayEnd,
    planning_ritual: planningRitual,
    first_plan_date: firstPlanDate,
    work_context: String(workContext || '').trim().slice(0, 2000),
    first_day_goal: String(firstDayGoal || '').trim().slice(0, 2000),
    automation_settings: automationSettings,
    completed_at: completed ? new Date().toISOString() : null
  };
  if (!configured || !client || !user) {
    localStorage.setItem(LOCAL_ONBOARDING_KEY, JSON.stringify(preferences));
    return preferences;
  }
  let { data, error } = await client.from('onboarding_preferences')
    .upsert({ user_id: user.id, ...preferences, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    .select('selected_providers,workday_start,workday_end,planning_ritual,first_plan_date,work_context,first_day_goal,automation_settings,completed_at').single();
  if (error && ['PGRST204', '42703'].includes(error.code)) {
    localStorage.setItem(LOCAL_ONBOARDING_KEY, JSON.stringify(preferences));
    const legacy = {
      selected_providers: providers,
      workday_start: workdayStart,
      workday_end: workdayEnd,
      planning_ritual: planningRitual,
      completed_at: preferences.completed_at,
      updated_at: new Date().toISOString()
    };
    ({ data, error } = await client.from('onboarding_preferences')
      .upsert({ user_id: user.id, ...legacy }, { onConflict: 'user_id' })
      .select('selected_providers,workday_start,workday_end,planning_ritual,completed_at').single());
    data = { ...(data || {}), ...preferences };
  }
  if (error) throw error;
  return data;
}

export async function createTask(task) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) {
    return { ...task, id: task.id || crypto.randomUUID() };
  }
  const project = projects.find(item => item.name === task.project || item.id === task.projectId);
  const { data, error } = await client
    .from('tasks')
    .insert({ ...taskToRow(task, project?.id), user_id: user.id })
    .select('*,project:projects(id,name,color)')
    .single();
  if (error) throw error;
  return normaliseTask(data);
}

export async function updateTask(id, changes) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) return;
  const row = {};
  if ('status' in changes) {
    row.status = changes.status;
    row.completed_at = changes.status === 'done' ? new Date().toISOString() : null;
  }
  if ('priority' in changes) row.priority = changes.priority;
  if ('title' in changes) row.title = changes.title;
  if ('notes' in changes) row.notes = changes.notes;
  if ('projectId' in changes) row.project_id = changes.projectId;
  if ('position' in changes) row.position = changes.position;
  if ('dueDate' in changes) row.due_date = changes.dueDate;
  if ('scheduledAt' in changes) row.scheduled_at = changes.scheduledAt;
  if ('plannedMinutes' in changes) row.planned_minutes = changes.plannedMinutes;
  if ('subtasks' in changes) row.subtasks = changes.subtasks;
  let { error } = await client.from('tasks').update(row).eq('id', id).eq('user_id', user.id);
  if (error && ['PGRST204', '42703'].includes(error.code) && 'subtasks' in row) {
    saveTaskExtra(id, { subtasks: changes.subtasks });
    delete row.subtasks;
    if (!Object.keys(row).length) return;
    ({ error } = await client.from('tasks').update(row).eq('id', id).eq('user_id', user.id));
  }
  if (error) throw error;
}

export async function deleteTask(id) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) return;
  const { error } = await client.from('tasks').delete().eq('id', id).eq('user_id', user.id);
  if (error) throw error;
}

export async function createSavedFilter(name, definition) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) {
    const filter = { id: crypto.randomUUID(), name, definition, position: savedFilters.length };
    savedFilters = [...savedFilters, filter];
    localStorage.setItem(LOCAL_FILTERS_KEY, JSON.stringify(savedFilters));
    return filter;
  }
  const { data, error } = await client.from('saved_filters').insert({ user_id: user.id, name, definition, position: savedFilters.length }).select().single();
  if (error) throw error;
  savedFilters = [...savedFilters, data];
  return data;
}

export async function deleteSavedFilter(id) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  savedFilters = savedFilters.filter(filter => filter.id !== id);
  if (!configured || !client || !user) {
    localStorage.setItem(LOCAL_FILTERS_KEY, JSON.stringify(savedFilters));
    return;
  }
  const { error } = await client.from('saved_filters').delete().eq('id', id).eq('user_id', user.id);
  if (error) throw error;
}

export async function searchWorkspaceTasks(searchText) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user || !searchText.trim()) return null;
  const { data, error } = await client.rpc('search_tasks', { search_text: searchText.trim() });
  if (error) throw error;
  return data.map(normaliseTask);
}

export async function loadDailyPlan(planDate) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) {
    const plans = JSON.parse(localStorage.getItem(LOCAL_PLANS_KEY) || '{}');
    return plans[planDate] || null;
  }
  const { data, error } = await client.from('daily_plans').select('*').eq('user_id', user.id).eq('plan_date', planDate).maybeSingle();
  if (error) throw error;
  return data;
}

export async function commitDayPlan({ planDate, workdayStart, workdayEnd, items }) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) {
    const plans = JSON.parse(localStorage.getItem(LOCAL_PLANS_KEY) || '{}');
    const plan = {
      plan_date: planDate,
      status: 'committed',
      workday_start: workdayStart,
      workday_end: workdayEnd,
      planned_minutes: items.reduce((total, item) => total + item.plannedMinutes, 0),
      committed_at: new Date().toISOString()
    };
    plans[planDate] = plan;
    localStorage.setItem(LOCAL_PLANS_KEY, JSON.stringify(plans));
    return { plan, tasks: [] };
  }

  const rpcItems = items.map((item, position) => ({
    task_id: item.taskId,
    scheduled_at: item.scheduledAt,
    planned_minutes: item.plannedMinutes,
    position
  }));
  const { data: plan, error } = await client.rpc('commit_day_plan', {
    p_plan_date: planDate,
    p_workday_start: workdayStart,
    p_workday_end: workdayEnd,
    p_items: rpcItems
  });
  if (error) throw error;

  const ids = items.map(item => item.taskId);
  const { data: rows, error: taskError } = await client
    .from('tasks')
    .select('*,project:projects(id,name,color)')
    .eq('user_id', user.id)
    .in('id', ids);
  if (taskError) throw taskError;
  return { plan, tasks: (rows || []).map(normaliseTask) };
}

export function persistLocalTasks(tasks) {
  const { configured, user } = getAuthState();
  if (configured && user) {
    localStorage.removeItem(LOCAL_TASKS_KEY);
    return;
  }
  localStorage.setItem(LOCAL_TASKS_KEY, JSON.stringify(tasks));
}

export function subscribeToWorkspace(userId, onChange) {
  const client = getSupabaseClient();
  if (!client || !userId) return () => {};
  if (realtimeChannel) client.removeChannel(realtimeChannel);
  let timer;
  realtimeChannel = client
    .channel(`workspace:${userId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}` }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'saved_filters', filter: `user_id=eq.${userId}` }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_plans', filter: `user_id=eq.${userId}` }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    })
    .subscribe();
  return () => {
    clearTimeout(timer);
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    realtimeChannel = null;
  };
}
