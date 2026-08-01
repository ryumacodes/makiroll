import { getAuthState, getSupabaseClient } from './supabase.js';

const LOCAL_TASKS_KEY = 'maki-tasks';
const LOCAL_FILTERS_KEY = 'maki-saved-filters';
const LOCAL_PLANS_KEY = 'maki-daily-plans';
const STARTER_PROJECTS = [
  { name: 'Studio relaunch', color: 'coral', position: 0 },
  { name: 'Home', color: 'sage', position: 1 },
  { name: 'Personal', color: 'blue', position: 2 }
];

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

const normaliseTask = row => {
  const project = row.project || projects.find(item => item.id === row.project_id);
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
  position: row.position || 0
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

function localWorkspace(fallbackTasks) {
  const localTasks = JSON.parse(localStorage.getItem(LOCAL_TASKS_KEY) || 'null') || fallbackTasks;
  projects = STARTER_PROJECTS.map((project, index) => ({ ...project, id: `local-${index}` }));
  savedFilters = JSON.parse(localStorage.getItem(LOCAL_FILTERS_KEY) || '[]');
  return { mode: 'local', tasks: localTasks, projects, savedFilters };
}

async function ensureProjects(client) {
  let { data, error } = await client.from('projects').select('id,name,color,position').is('archived_at', null).order('position');
  if (error) throw error;
  if (data.length) return data;

  ({ data, error } = await client.from('projects').insert(STARTER_PROJECTS).select('id,name,color,position'));
  if (error) throw error;
  return data;
}

async function seedTasks(client, fallbackTasks, projectRows) {
  if (!fallbackTasks.length) return [];
  const projectIds = new Map(projectRows.map(project => [project.name, project.id]));
  const rows = fallbackTasks.map((task, index) => ({
    ...taskToRow({ ...task, position: index }, projectIds.get(task.project)),
    position: index
  }));
  const { data, error } = await client.from('tasks').insert(rows).select('*,project:projects(id,name,color)');
  if (error) throw error;
  return data;
}

export async function loadWorkspace(fallbackTasks = []) {
  const client = getSupabaseClient();
  const { configured, user } = getAuthState();
  if (!configured || !client || !user) return localWorkspace(fallbackTasks);

  projects = await ensureProjects(client);
  let { data: taskRows, error: taskError } = await client
    .from('tasks')
    .select('*,project:projects(id,name,color)')
    .neq('status', 'archived')
    .order('position');
  if (taskError) throw taskError;
  if (!taskRows.length) taskRows = await seedTasks(client, fallbackTasks, projects);

  const { data: filterRows, error: filterError } = await client.from('saved_filters').select('*').order('position');
  if (filterError) throw filterError;
  savedFilters = filterRows;

  localStorage.setItem(LOCAL_TASKS_KEY, JSON.stringify(taskRows.map(normaliseTask)));
  return { mode: 'remote', tasks: taskRows.map(normaliseTask), projects, savedFilters };
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
    .insert(taskToRow(task, project?.id))
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
  const { error } = await client.from('tasks').update(row).eq('id', id);
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
  const { data, error } = await client.from('saved_filters').insert({ name, definition, position: savedFilters.length }).select().single();
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
  const { error } = await client.from('saved_filters').delete().eq('id', id);
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
  const { data, error } = await client.from('daily_plans').select('*').eq('plan_date', planDate).maybeSingle();
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
    .in('id', ids);
  if (taskError) throw taskError;
  return { plan, tasks: (rows || []).map(normaliseTask) };
}

export function persistLocalTasks(tasks) {
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
