const DATABASE_NAME = "study-buddy-files";
const DATABASE_VERSION = 1;
const FILE_STORE = "files";
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const COLOR_NAMES = ["blue", "violet", "mint", "amber", "rose"];
const PAGE_NAMES = { dashboard: "Overview", tasks: "Tasks", courses: "Courses", materials: "Materials", planner: "Planner", focus: "Focus room", settings: "Settings & backup" };
const IN_EXTENSION = Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
const DEFAULT_STATE = { tasks: [], courses: [], materials: [], sessions: [], settings: { reminderTime: "09:00", focusMinutes: 25, breakMinutes: 5, dailyGoalMinutes: 120, notifications: false } };

let state = structuredClone(DEFAULT_STATE);
let page = "dashboard";
let taskFilter = "open";
let materialFilter = "all";
let plannerOffset = 0;
let editingCourseId = "";
let timerInterval = null;
let timerRemaining = 25 * 60;
let timerRunning = false;
let timerMode = "focus";
let toastTimer = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const el = (id) => document.getElementById(id);
const uid = () => crypto.randomUUID();
const esc = (value = "") => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const dateFromKey = (key) => { const [y,m,d] = key.split("-").map(Number); return new Date(y,m-1,d); };
const addDays = (key, count) => { const d = dateFromKey(key); d.setDate(d.getDate()+count); return dateKey(d); };
const dayDifference = (key) => Math.round((dateFromKey(key)-dateFromKey(dateKey()))/86400000);
const formatDate = (key, options = { weekday:"short", month:"short", day:"numeric" }) => dateFromKey(key).toLocaleDateString(undefined, options);
const courseById = (id) => state.courses.find((course) => course.id === id);
const courseName = (id) => courseById(id)?.name || "Unassigned";
const taskById = (id) => state.tasks.find((task) => task.id === id);
const sortedOpenTasks = () => state.tasks.filter((task) => !task.completed).sort((a,b) => {
  if (!a.dueDate) return b.dueDate ? 1 : (a.title||"").localeCompare(b.title||"");
  if (!b.dueDate) return -1;
  return a.dueDate.localeCompare(b.dueDate) || (a.priority === "high" ? -1 : 1);
});

async function readState() {
  if (IN_EXTENSION) {
    const data = await chrome.storage.local.get(["studyBuddyState", "tasks", "reminderTime"]);
    if (data.studyBuddyState) return normalizeState(data.studyBuddyState);
    if (Array.isArray(data.tasks) && data.tasks.length) {
      const migratedCourses = [...new Set(data.tasks.map((task) => task.course).filter(Boolean))].map((name, i) => ({ id: `migrated-${i}-${uid()}`, name, code: "", color: COLOR_NAMES[i%COLOR_NAMES.length], description: "" }));
      const migratedTasks = data.tasks.map((task) => ({ ...task, id: task.id || uid(), courseId: migratedCourses.find((c) => c.name === task.course)?.id || "", type: "Assignment", priority: "normal", effort: 60, notes: "", attachments: [], seriesId: task.repeatWeekly ? (task.seriesId || task.id) : "" }));
      return normalizeState({ ...DEFAULT_STATE, tasks: migratedTasks, courses: migratedCourses, settings: { ...DEFAULT_STATE.settings, reminderTime: data.reminderTime || "09:00" } });
    }
    return structuredClone(DEFAULT_STATE);
  }
  try { return normalizeState(JSON.parse(localStorage.getItem("studyBuddyState") || "null") || DEFAULT_STATE); }
  catch { return structuredClone(DEFAULT_STATE); }
}

function normalizeState(value) {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...value,
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
    courses: Array.isArray(value.courses) ? value.courses : [],
    materials: Array.isArray(value.materials) ? value.materials : [],
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
    settings: { ...DEFAULT_STATE.settings, ...(value.settings || {}) }
  };
}

async function saveState() {
  if (IN_EXTENSION) {
    await chrome.storage.local.set({ studyBuddyState: state });
    chrome.runtime.sendMessage({ type: "stateChanged" }).catch(() => {});
  } else {
    localStorage.setItem("studyBuddyState", JSON.stringify(state));
    scheduleWebReminder();
  }
  render();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(FILE_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function fileStore(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, mode);
    const store = tx.objectStore(FILE_STORE);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function storeFile(file, metadata) {
  await fileStore("readwrite", (store) => store.put({ ...metadata, blob: file }));
}
async function getFile(id) { return fileStore("readonly", (store) => store.get(id)); }
async function deleteFile(id) { return fileStore("readwrite", (store) => store.delete(id)); }

function toast(message) {
  const node = el("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

function emptyState(icon, title, description, buttonText, action) {
  return `<div class="empty-card"><div><span class="empty-illustration">${icon}</span><strong>${esc(title)}</strong><p>${esc(description)}</p>${buttonText ? `<button class="button button-primary" data-action="${action}">${esc(buttonText)} <span>↗</span></button>` : ""}</div></div>`;
}

function dateLabel(task) {
  if (!task.dueDate) return { text: "No deadline", cls: "" };
  const diff = dayDifference(task.dueDate);
  if (diff < 0) return { text: `Overdue · ${formatDate(task.dueDate)}`, cls: "overdue" };
  if (diff === 0) return { text: "Due today", cls: "today" };
  if (diff === 1) return { text: "Due tomorrow", cls: "soon" };
  return { text: `Due ${formatDate(task.dueDate)}`, cls: diff <= 3 ? "soon" : "" };
}

function taskRow(task, compact = false) {
  const date = dateLabel(task);
  const course = courseById(task.courseId);
  return `<article class="task-row ${task.completed ? "is-done" : ""}">
    <input class="task-check" type="checkbox" data-action="complete" data-id="${esc(task.id)}" ${task.completed ? "checked" : ""} aria-label="Mark ${esc(task.title)} complete">
    <span class="task-accent ${task.priority === "high" ? "high" : task.priority === "low" ? "low" : ""}"></span>
    <div class="task-copy"><p class="task-name" title="${esc(task.title)}">${esc(task.title)}</p><div class="task-sub"><span class="task-course">${esc(course?.name || "Unassigned")}</span><span>·</span><span>${esc(task.type || "Assignment")}</span>${task.repeatWeekly ? `<span>·</span><span>↻ weekly</span>` : ""}${task.attachments?.length ? `<span>·</span><span>▱ ${task.attachments.length} file${task.attachments.length===1?"":"s"}</span>` : ""}</div></div>
    <span class="task-date ${date.cls}">${esc(date.text)}</span>
    ${compact ? "" : `<div class="task-tools"><button class="task-tool" data-action="edit-task" data-id="${esc(task.id)}" title="Edit" aria-label="Edit">✎</button><button class="task-tool delete" data-action="delete-task" data-id="${esc(task.id)}" title="Delete" aria-label="Delete">×</button></div>`}
  </article>`;
}

function courseOptions(selected = "", includeAll = false) {
  return `${includeAll ? `<option value="">All courses</option>` : `<option value="">Unassigned</option>`}${state.courses.map((course) => `<option value="${esc(course.id)}" ${course.id===selected?"selected":""}>${esc(course.name)}</option>`).join("")}`;
}

function renderDashboard() {
  const open = sortedOpenTasks();
  const today = dateKey();
  const weekStart = (() => { const d = dateFromKey(today); d.setDate(d.getDate() - ((d.getDay()+6)%7)); return dateKey(d); })();
  const weekEnd = addDays(weekStart, 6);
  const weekTasks = state.tasks.filter((t) => t.dueDate && t.dueDate >= weekStart && t.dueDate <= weekEnd);
  const finished = weekTasks.filter((t) => t.completed).length;
  const pct = weekTasks.length ? Math.round(finished / weekTasks.length * 100) : 0;
  const nowHour = new Date().getHours();
  const greeting = nowHour < 12 ? "Good morning" : nowHour < 18 ? "Good afternoon" : "Good evening";
  const next = open.filter((t) => t.dueDate).slice(0,5);
  const overdue = open.filter((t) => t.dueDate && dayDifference(t.dueDate) < 0);
  const courseCards = state.courses.slice(0,4);
  const weekDays = Array.from({length:7}, (_,i) => {
    const key = addDays(weekStart,i), d = dateFromKey(key);
    const count = open.filter((t) => t.dueDate === key).length;
    return `<div class="week-day ${key===today?"today":""}"><span class="day-name">${d.toLocaleDateString(undefined,{weekday:"short"})}</span><strong class="day-number">${d.getDate()}</strong><span class="day-dots">${Array.from({length:Math.min(count,4)},()=>`<i class="day-dot"></i>`).join("")}</span></div>`;
  }).join("");
  return `<section class="page-intro"><div><p class="eyebrow">${formatDate(today,{weekday:"long",month:"long",day:"numeric"}).toUpperCase()}</p><h1>${greeting}, let’s make a little progress.</h1><p>Your courses, study files, and next steps all in one calm space.</p></div><div class="intro-actions"><button class="button button-soft" data-action="open-upload">↑ Upload materials</button><button class="button button-primary" data-action="open-task">＋ Add study item</button></div></section>
  <section class="grid dashboard-grid">
    <div class="column-stack">
      <article class="hero-card"><div class="hero-top"><div><p class="eyebrow">A GOOD PLACE TO START</p><h2>${open.length ? `${open.length} open item${open.length===1?"":"s"} on your list.` : "Your next chapter starts here."}</h2><p>${open.length ? (overdue.length ? `${overdue.length} overdue item${overdue.length===1?"":"s"} need a fresh look. Pick one and make a start.` : "Choose one small task and give it your focus. You’re building momentum one session at a time.") : "Add a course or assignment to build your personal study workspace."}</p></div><span class="hero-spark">✦</span></div><div class="hero-bottom"><div class="hero-progress"><span>This week</span><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><strong>${finished}/${weekTasks.length}</strong></div><button class="button" data-page="planner">See weekly plan ↗</button></div></article>
      <article class="card card-pad"><div class="card-heading"><div><h2>This week</h2><p>Deadlines and plans at a glance</p></div><span class="heading-icon">▧</span></div><div class="week-strip">${weekDays}</div></article>
      <article class="card card-pad"><div class="card-heading"><div><h2>Coming up</h2><p>Your next deadlines and study items</p></div><button class="button-quiet" data-page="tasks">View all ↗</button></div>${overdue.length?`<div class="overdue-banner">${overdue.length} item${overdue.length===1?"":"s"} overdue. Update a deadline or choose your next step.</div>`:""}${next.length?`<div class="task-stack">${next.map((task)=>taskRow(task)).join("")}</div>`:emptyState("▤","Nothing due yet","Add assignments, exams, reading, or your next study goal.","Add a study item","open-task")}</article>
      <article class="card card-pad"><div class="card-heading"><div><h2>Your courses</h2><p>${state.courses.length} course${state.courses.length===1?"":"s"} in this workspace</p></div><button class="button-quiet" data-action="open-course">＋ Add course</button></div>${courseCards.length?`<div class="course-mini-grid">${courseCards.map((c)=>{const count=state.tasks.filter(t=>t.courseId===c.id&&!t.completed).length;return `<button class="course-mini" data-action="go-course" data-id="${esc(c.id)}"><span class="course-color ${esc(c.color)}">${esc((c.code||c.name).slice(0,2).toUpperCase())}</span><span><strong>${esc(c.name)}</strong><small>${count} open item${count===1?"":"s"}</small></span></button>`}).join("")}</div>`:emptyState("▦","Add your first course","Keep each class, deadline, and file together.","Create a course","open-course")}</article>
    </div>
    <div class="column-stack">
      <article class="card card-pad"><div class="card-heading"><div><h2>Today’s focus</h2><p>A simple, deadline-aware starting list</p></div><span class="heading-icon">◷</span></div>${open.length?`<div class="quick-plan">${open.slice(0,4).map((task,i)=>`<div class="plan-item"><span class="plan-time">${i===0?"START HERE":`${Math.round((task.effort||60)/60*10)/10} H`}</span><span class="plan-line"></span><div><strong>${esc(task.title)}</strong><small>${esc(courseName(task.courseId))}${task.dueDate?` · ${esc(dateLabel(task).text)}`:" · No deadline yet"}</small></div></div>`).join("")}</div>`:`<div class="empty-state-inline"><span>☀</span><p>Add an item and we’ll suggest a sensible place to begin.</p></div>`}<button class="button-quiet" data-page="focus">Start a focus session ↗</button></article>
      <article class="card card-pad"><div class="card-heading"><div><h2>Focus room</h2><p>Take one thing at a time</p></div><span class="heading-icon">◉</span></div><div class="focus-widget"><div><strong>Ready for a focus session?</strong><small>${Number(state.settings.focusMinutes)||25} minutes on, then a short break.</small></div><span class="focus-time">${String(state.settings.focusMinutes||25).padStart(2,"0")}:00</span></div><button class="button-quiet" data-page="focus">Open focus room ↗</button></article>
      <article class="card card-pad"><div class="card-heading"><div><h2>Study files</h2><p>Keep notes and course materials close</p></div><span class="heading-icon">▱</span></div><div class="quick-plan"><div class="plan-item"><span class="plan-time">PRIVATE</span><span class="plan-line"></span><div><strong>${state.materials.length} uploaded file${state.materials.length===1?"":"s"}</strong><small>Stored only in this browser</small></div></div><div class="plan-item"><span class="plan-time">PDF · DOC · IMG</span><span class="plan-line"></span><div><strong>Attach files to a course or task</strong><small>Each file can be up to 25 MB</small></div></div></div><button class="button-quiet" data-action="open-upload">Upload study materials ↗</button></article>
      <article class="card card-pad"><div class="card-heading"><div><h2>Term progress</h2><p>A little at a time adds up</p></div><span class="heading-icon">◌</span></div><div class="progress-summary"><span>${state.tasks.filter(t=>t.completed).length} of ${state.tasks.length} items complete</span><strong>${state.tasks.length?Math.round(state.tasks.filter(t=>t.completed).length/state.tasks.length*100):0}%</strong></div><div class="wide-progress"><span style="width:${state.tasks.length?Math.round(state.tasks.filter(t=>t.completed).length/state.tasks.length*100):0}%"></span></div></article>
    </div>
  </section>`;
}

function renderTasks() {
  const filterCourse = el("task-course-filter")?.value || "";
  let rows = state.tasks.filter((task) => taskFilter === "all" || (taskFilter === "open" ? !task.completed : task.completed));
  if (filterCourse) rows = rows.filter((task) => task.courseId === filterCourse);
  rows.sort((a,b) => (a.dueDate||"9999").localeCompare(b.dueDate||"9999"));
  return `<section class="page-intro"><div><p class="eyebrow">STAY ON TOP OF IT</p><h1>Your study items</h1><p>Assignments, exams, readings, and personal goals with room to adjust as plans change.</p></div><div class="intro-actions"><button class="button button-primary" data-action="open-task">＋ Add study item</button></div></section>
  <div class="section-toolbar"><div class="toolbar-left"><div class="segmented"><button class="segment ${taskFilter==="open"?"active":""}" data-task-filter="open">Open <span>${state.tasks.filter(t=>!t.completed).length}</span></button><button class="segment ${taskFilter==="done"?"active":""}" data-task-filter="done">Completed</button><button class="segment ${taskFilter==="all"?"active":""}" data-task-filter="all">All</button></div><select class="select-input" id="task-course-filter">${courseOptions(filterCourse,true)}</select></div><div class="toolbar-right"><span class="muted-caption">${rows.length} item${rows.length===1?"":"s"}</span></div></div>
  ${rows.length?`<div class="list-table"><div class="list-table-head"><span>Study item</span><span>Course</span><span>Deadline</span><span>Priority</span><span></span></div>${rows.map((t)=>{const date=dateLabel(t);return `<div class="list-table-row"><div class="table-title"><input class="task-check" type="checkbox" data-action="complete" data-id="${esc(t.id)}" ${t.completed?"checked":""}><span><strong>${esc(t.title)}</strong><small>${esc(t.type||"Assignment")}${t.repeatWeekly?" · Repeats weekly":""}${t.attachments?.length?` · ${t.attachments.length} file(s)`:""}</small></span></div><span class="table-cell">${esc(courseName(t.courseId))}</span><span class="table-cell task-date ${date.cls}">${esc(date.text)}</span><span><i class="tag ${t.priority==="high"?"rose":t.priority==="low"?"green":"blue"}">${esc(t.priority||"normal")}</i></span><div class="table-actions"><button class="task-tool" data-action="edit-task" data-id="${esc(t.id)}" aria-label="Edit item">✎</button><button class="task-tool delete" data-action="delete-task" data-id="${esc(t.id)}" aria-label="Delete item">×</button></div></div>`}).join("")}</div>`:emptyState("▤",taskFilter==="done"?"No completed items yet":"Your list is clear","Add an item when something needs your attention. You can update or remove it anytime.","Add a study item","open-task")}`;
}

function renderCourses() {
  return `<section class="page-intro"><div><p class="eyebrow">A HOME FOR EACH CLASS</p><h1>Your courses</h1><p>Keep course notes, files, and work together throughout the term.</p></div><div class="intro-actions"><button class="button button-primary" data-action="open-course">＋ Add course</button></div></section>
  ${state.courses.length?`<div class="course-grid">${state.courses.map((course)=>{const tasks=state.tasks.filter(t=>t.courseId===course.id),files=state.materials.filter(m=>m.courseId===course.id);return `<article class="card course-card color-${esc(course.color)}"><div class="course-card-head"><span class="course-color ${esc(course.color)}">${esc((course.code||course.name).slice(0,2).toUpperCase())}</span><div class="course-menu"><button class="task-tool" data-action="edit-course" data-id="${esc(course.id)}" aria-label="Edit course">✎</button><button class="task-tool delete" data-action="delete-course" data-id="${esc(course.id)}" aria-label="Delete course">×</button></div></div><h3>${esc(course.name)}</h3><p>${esc(course.description||"Add instructor details, office hours, or course notes.")}</p><div class="course-stats"><span><strong>${tasks.filter(t=>!t.completed).length}</strong> open</span><span><strong>${tasks.filter(t=>t.completed).length}</strong> done</span><span><strong>${files.length}</strong> files</span></div><button class="button-quiet" data-action="course-tasks" data-id="${esc(course.id)}">View course items ↗</button></article>`}).join("")}</div>`:emptyState("▦","Start with a course","Add your classes to sort study items and files by subject.","Add your first course","open-course")}`;
}

function formatSize(bytes) { return bytes < 1024*1024 ? `${Math.max(1,Math.round(bytes/1024))} KB` : `${(bytes/(1024*1024)).toFixed(1)} MB`; }
function fileGlyph(file) { if ((file.type||"").startsWith("image/")) return { icon:"▧", cls:"image" }; if (file.type==="application/pdf"||file.name.toLowerCase().endsWith(".pdf")) return { icon:"PDF", cls:"pdf" }; if (/presentation|powerpoint/.test(file.type)||/\.pptx?$/.test(file.name.toLowerCase())) return { icon:"▤", cls:"" }; if (/word|document/.test(file.type)||/\.docx?$/.test(file.name.toLowerCase())) return { icon:"W", cls:"" }; return { icon:"▱", cls:"" }; }

function renderMaterials() {
  const chosenCourse = el("material-course-filter")?.value || "";
  const files = state.materials.filter((file) => (materialFilter === "all" || (materialFilter === "unassigned" ? !file.courseId : file.courseId===materialFilter)) && (!chosenCourse || file.courseId===chosenCourse));
  return `<section class="page-intro"><div><p class="eyebrow">NOTES, SLIDES, AND READINGS</p><h1>Your materials</h1><p>Upload class files and keep them linked to the right course or assignment.</p></div><div class="intro-actions"><button class="button button-primary" data-action="open-upload">↑ Upload files</button></div></section>
  <div class="upload-zone" data-action="open-upload"><div><span class="upload-symbol">↑</span><strong>Drop your study files here or choose files</strong><small>PDFs, slides, documents, images, and more · 25 MB per file</small></div></div>
  <div class="section-toolbar"><div class="toolbar-left"><div class="segmented"><button class="segment ${materialFilter==="all"?"active":""}" data-material-filter="all">All files</button><button class="segment ${materialFilter==="unassigned"?"active":""}" data-material-filter="unassigned">Unassigned</button></div><select class="select-input" id="material-course-filter">${courseOptions(chosenCourse,true)}</select></div><span class="muted-caption">${files.length} file${files.length===1?"":"s"} · private to this browser</span></div>
  ${files.length?`<div class="materials-grid">${files.map((file)=>{const glyph=fileGlyph(file),task=taskById(file.taskId);return `<article class="material-card"><div class="material-preview ${glyph.cls}">${glyph.icon}</div><div class="material-info"><p class="material-name" title="${esc(file.name)}">${esc(file.name)}</p><p class="material-meta">${esc(courseName(file.courseId))}${task?` · ${esc(task.title)}`:""} · ${formatSize(file.size)}</p><div class="material-footer"><button class="button-quiet" data-action="open-file" data-id="${esc(file.id)}">Open file ↗</button><button class="task-tool delete" data-action="delete-file" data-id="${esc(file.id)}" aria-label="Remove file">×</button></div></div></article>`}).join("")}</div>`:emptyState("▱","Your materials live here","Upload lecture notes, syllabi, problem sets, or reference sheets. They stay on this device.","Upload your first file","open-upload")}`;
}

function renderPlanner() {
  const today=dateKey(),start=(()=>{const d=dateFromKey(today);d.setDate(d.getDate()-((d.getDay()+6)%7)+plannerOffset*7);return dateKey(d)})();
  const days=Array.from({length:7},(_,i)=>{const key=addDays(start,i),d=dateFromKey(key),items=state.tasks.filter(t=>!t.completed&&t.dueDate===key);return `<div class="calendar-day ${key===today?"today":""}"><div class="calendar-head"><span>${d.toLocaleDateString(undefined,{weekday:"short"})}</span><strong>${d.getDate()}</strong></div>${items.length?items.map(t=>`<div class="calendar-task ${t.priority==="high"?"high":""}">${esc(t.title)}</div>`).join(""):`<div class="calendar-empty">—</div>`}</div>`}).join("");
  const upcoming=sortedOpenTasks().filter(t=>t.dueDate).slice(0,10);
  const weekTitle=plannerOffset===0?"This week":plannerOffset===1?"Next week":plannerOffset===-1?"Last week":`Week of ${formatDate(start,{month:"short",day:"numeric"})}`;
  return `<section class="page-intro"><div><p class="eyebrow">MAKE SPACE FOR WHAT MATTERS</p><h1>Your weekly plan</h1><p>Review deadline dates, make room for study sessions, and adjust when life changes.</p></div><div class="intro-actions"><button class="button button-primary" data-action="open-task">＋ Plan study item</button></div></section>
  <article class="card card-pad"><div class="card-heading"><div><h2>${weekTitle}</h2><p>Monday through Sunday · ${formatDate(start,{month:"short",day:"numeric"})}–${formatDate(addDays(start,6),{month:"short",day:"numeric"})}</p></div><div class="week-controls"><button class="task-tool" data-week-shift="-1" aria-label="Previous week">‹</button><button class="task-tool" data-week-shift="1" aria-label="Next week">›</button></div></div><div class="week-calendar">${days}</div></article>
  <article class="card card-pad upcoming-planner"><div class="card-heading"><div><h2>Upcoming deadlines</h2><p>Sorted by date</p></div><span class="tag blue">${upcoming.length} coming up</span></div>${upcoming.length?`<div class="task-stack">${upcoming.map(t=>taskRow(t)).join("")}</div>`:emptyState("▧","No dates on the calendar","Add a deadline to see your study week take shape.","Add a study item","open-task")}</article>`;
}

function renderFocus() {
  const sessions=state.sessions.slice(-8).reverse();
  return `<section class="page-intro"><div><p class="eyebrow">ONE THING AT A TIME</p><h1>Focus room</h1><p>Set a small focus block, take a breather, and keep a record of the time you put in.</p></div></section>
  <section class="focus-layout"><article class="card focus-card"><div><p class="eyebrow">${timerMode==="focus"?"FOCUS BLOCK":"SHORT BREAK"}</p><div class="timer-ring ${timerMode==="break"?"break":""}"><div><div id="timer-display" class="timer-time">${timerText()}</div><div class="timer-mode">${timerRunning?"IN PROGRESS":"READY WHEN YOU ARE"}</div></div></div><div class="timer-settings"><button class="timer-preset ${state.settings.focusMinutes===25?"active":""}" data-focus-preset="25">25 / 5</button><button class="timer-preset ${state.settings.focusMinutes===45?"active":""}" data-focus-preset="45">45 / 10</button><button class="timer-preset ${state.settings.focusMinutes===50?"active":""}" data-focus-preset="50">50 / 10</button></div><div class="timer-controls"><button id="timer-reset" class="button button-soft">Reset</button><button id="timer-toggle" class="button button-primary">${timerRunning?"Pause":"Start focus"} ${timerRunning?"Ⅱ":"▶"}</button><button id="timer-break" class="button button-soft">Take a break</button></div></div></article>
  <div class="column-stack"><article class="card card-pad"><div class="card-heading"><div><h2>Recent sessions</h2><p>Small blocks add up</p></div><span class="heading-icon">◷</span></div>${sessions.length?`<div class="session-list">${sessions.map(s=>`<div class="session-row"><span>${formatDate(s.date,{month:"short",day:"numeric"})} · ${esc(s.mode||"Focus")}</span><strong>${s.minutes} min</strong></div>`).join("")}</div>`:`<div class="empty-state-inline"><span>◷</span><p>Your completed focus sessions will show here.</p></div>`}</article><article class="card card-pad"><div class="card-heading"><div><h2>Pick a task</h2><p>Focus on your next open item</p></div></div>${sortedOpenTasks().slice(0,4).map(t=>`<button class="focus-pick" data-action="focus-task" data-id="${esc(t.id)}"><span><strong>${esc(t.title)}</strong><small>${esc(courseName(t.courseId))}</small></span><span>↗</span></button>`).join("")||`<p class="muted-caption">Add a study item to start a session.</p>`}</article></div></section>`;
}

function renderSettings() {
  return `<section class="page-intro"><div><p class="eyebrow">MAKE IT YOUR OWN</p><h1>Settings & backup</h1><p>Choose reminder timing and keep a copy of your study plan.</p></div></section>
  <section class="settings-grid"><article class="card settings-card"><div class="card-heading"><div><h2>Deadline reminders</h2><p>One reminder per day during the seven days before a deadline.</p></div><span class="heading-icon">♢</span></div><div class="settings-row"><span><strong>Reminder time</strong><small>Uses this device’s local time.</small></span><input id="settings-reminder-time" type="time" value="${esc(state.settings.reminderTime||"09:00")}"></div><div class="settings-row"><span><strong>Notifications on this site</strong><small>${IN_EXTENSION?"Browser extension alarms can notify while this workspace is closed.":"Site reminders work while this tab is open."}</small></span><button class="button ${state.settings.notifications?"button-soft":"button-primary"}" data-action="toggle-notifications">${state.settings.notifications?"Turn off":"Enable reminders"}</button></div><div class="settings-row"><span><strong>Weekly assignments</strong><small>Completing a repeating item creates its next week’s item.</small></span><span class="tag green">Enabled per item</span></div></article>
  <article class="card settings-card"><div class="card-heading"><div><h2>Study routine</h2><p>Set focus blocks that fit your day.</p></div><span class="heading-icon">◷</span></div><div class="settings-row"><span><strong>Daily study goal</strong><small>Minutes you hope to study</small></span><input id="settings-goal" type="number" min="15" max="720" step="15" value="${Number(state.settings.dailyGoalMinutes)||120}"></div><div class="settings-row"><span><strong>Focus block</strong><small>Minutes before a short break</small></span><input id="settings-focus-minutes" type="number" min="10" max="120" step="5" value="${Number(state.settings.focusMinutes)||25}"></div><div class="settings-row"><span><strong>Short break</strong><small>Reset between focus blocks</small></span><input id="settings-break-minutes" type="number" min="3" max="30" step="1" value="${Number(state.settings.breakMinutes)||5}"></div></article>
  <article class="card settings-card"><div class="card-heading"><div><h2>Back up your plan</h2><p>Export courses and tasks as a JSON file. Study files remain in this browser and are not included.</p></div><span class="heading-icon">↓</span></div><div class="settings-row"><span><strong>Download a backup</strong><small>Save a copy before switching browsers.</small></span><button class="button button-soft" data-action="export-data">Export backup</button></div><div class="settings-row"><span><strong>Restore a backup</strong><small>Choose a Study Buddy JSON backup.</small></span><label class="button button-soft import-button">Choose file<input id="import-file" type="file" accept="application/json,.json"></label></div></article>
  <article class="card settings-card"><div class="card-heading"><div><h2>About this workspace</h2><p>A private, device-first study organizer for any course or term.</p></div><span class="heading-icon">✦</span></div><div class="settings-row"><span><strong>Where your data lives</strong><small>Courses and tasks are stored in this browser. Uploaded files live in local browser storage.</small></span><span class="tag green">On this device</span></div><div class="settings-row"><span><strong>AI model</strong><small>This version works without sending study data to an AI service.</small></span><span class="tag blue">Optional future add-on</span></div></article></section>`;
}

function render() {
  $$(".nav-link[data-page]").forEach((button)=>button.classList.toggle("active",button.dataset.page===page));
  el("current-section").textContent=PAGE_NAMES[page]||"Overview";
  el("nav-task-count").textContent=state.tasks.filter(t=>!t.completed).length;
  const container=el("view-container");
  container.innerHTML=({dashboard:renderDashboard,tasks:renderTasks,courses:renderCourses,materials:renderMaterials,planner:renderPlanner,focus:renderFocus,settings:renderSettings}[page]||renderDashboard)();
}

function showPage(next) {
  if (!PAGE_NAMES[next]) return;
  page=next;
  el("global-search-results").hidden=true;
  render();
  if (IN_EXTENSION) history.replaceState(null,"",`#${next}`); else history.replaceState(null,"",`#${next}`);
}

function openTaskDialog(task = null) {
  el("task-form").reset();
  el("task-id").value=task?.id||"";
  el("task-dialog-title").textContent=task?"Edit study item":"Add a study item";
  el("task-title").value=task?.title||"";
  el("task-course").innerHTML=courseOptions(task?.courseId||"");
  el("task-type").value=task?.type||"Assignment";
  el("task-date").value=task?.dueDate||"";
  el("task-priority").value=task?.priority||"normal";
  el("task-effort").value=String(task?.effort||60);
  el("task-repeat").checked=Boolean(task?.repeatWeekly);
  el("task-notes").value=task?.notes||"";
  el("task-dialog").showModal();
  el("task-title").focus();
}

function openCourseDialog(course=null) {
  editingCourseId=course?.id||"";
  el("course-form").reset();
  el("course-dialog-title").textContent=course?"Edit course":"Add a course";
  el("course-id").value=course?.id||"";
  el("course-name").value=course?.name||"";
  el("course-code").value=course?.code||"";
  el("course-color").value=course?.color||COLOR_NAMES[state.courses.length%COLOR_NAMES.length];
  el("course-description").value=course?.description||"";
  el("course-dialog").showModal();
}

function openUploadDialog() {
  el("upload-form").reset();
  el("upload-course").innerHTML=courseOptions();
  el("upload-task").innerHTML=`<option value="">No linked task</option>${sortedOpenTasks().map(t=>`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join("")}`;
  el("upload-dialog").showModal();
}

function ensureNextOccurrence(task) {
  if (!task.repeatWeekly || !task.dueDate) return;
  task.seriesId ||= task.id;
  const due=addDays(task.dueDate,7), id=`${task.seriesId}-${due}`;
  if (!state.tasks.some((item)=>item.id===id)) state.tasks.push({ ...task, id, dueDate:due, completed:false, attachments:[] });
}

el("task-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  if(el("task-repeat").checked&&!el("task-date").value){toast("Add a deadline to set up a weekly repeating item.");el("task-date").focus();return;}
  const id=el("task-id").value;
  const task=id?taskById(id):{id:uid(),completed:false,attachments:[],createdAt:new Date().toISOString()};
  if (!task) return;
  const wasRepeating=task.repeatWeekly;
  Object.assign(task,{title:el("task-title").value.trim(),courseId:el("task-course").value,type:el("task-type").value,dueDate:el("task-date").value,priority:el("task-priority").value,effort:Number(el("task-effort").value),repeatWeekly:el("task-repeat").checked,notes:el("task-notes").value.trim(),updatedAt:new Date().toISOString()});
  if (task.repeatWeekly) task.seriesId ||= task.id; else if (wasRepeating) task.seriesId="";
  if (!id) state.tasks.unshift(task);
  await saveState();
  el("task-dialog").close();
  toast(id?"Study item updated.":"Study item added.");
});

el("course-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  const id=el("course-id").value;
  const course=id?courseById(id):{id:uid(),createdAt:new Date().toISOString()};
  if (!course) return;
  Object.assign(course,{name:el("course-name").value.trim(),code:el("course-code").value.trim(),color:el("course-color").value,description:el("course-description").value.trim()});
  if (!id) state.courses.push(course);
  await saveState();
  el("course-dialog").close();
  toast(id?"Course updated.":"Course added.");
});

el("upload-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  const files=[...el("file-input").files];
  if (!files.length) { toast("Choose at least one file first."); return; }
  const tooLarge=files.find((file)=>file.size>MAX_FILE_SIZE);
  if (tooLarge) { toast(`${tooLarge.name} is larger than 25 MB.`); return; }
  const courseId=el("upload-course").value, taskId=el("upload-task").value;
  try {
    for (const file of files) {
      const id=uid();
      const metadata={id,name:file.name,type:file.type||"application/octet-stream",size:file.size,courseId,taskId,addedAt:new Date().toISOString()};
      await storeFile(file,metadata);
      state.materials.unshift(metadata);
      if (taskId) { const task=taskById(taskId); if (task) { task.attachments ||= []; task.attachments.push(id); } }
    }
    await saveState();
    el("upload-dialog").close();
    toast(`${files.length} file${files.length===1?"":"s"} added to your materials.`);
  } catch (error) {
    console.error(error);
    toast("Couldn’t save those files. Check your browser storage space and try again.");
  }
});

document.addEventListener("click",async(event)=>{
  const close=event.target.closest("[data-close]");
  if(close) { el(close.dataset.close).close(); return; }
  const nav=event.target.closest("[data-page]");
  if(nav) { showPage(nav.dataset.page); return; }
  const filterButton=event.target.closest("[data-task-filter]");
  if(filterButton) { taskFilter=filterButton.dataset.taskFilter; render(); return; }
  const weekShift=event.target.closest("[data-week-shift]");
  if(weekShift) { plannerOffset+=Number(weekShift.dataset.weekShift); render(); return; }
  const materialButton=event.target.closest("[data-material-filter]");
  if(materialButton) { materialFilter=materialButton.dataset.materialFilter; render(); return; }
  const preset=event.target.closest("[data-focus-preset]");
  if(preset) { if(timerRunning) return; state.settings.focusMinutes=Number(preset.dataset.focusPreset); timerMode="focus"; timerRemaining=state.settings.focusMinutes*60; await saveState(); return; }
  const control=event.target.closest("[data-action]");
  if(!control) return;
  const action=control.dataset.action,id=control.dataset.id;
  if(action==="open-task") { openTaskDialog(); return; }
  if(action==="open-course") { openCourseDialog(); return; }
  if(action==="open-upload") { openUploadDialog(); return; }
  if(action==="edit-task") { openTaskDialog(taskById(id)); return; }
  if(action==="delete-task") {
    const task=taskById(id);
    if(!task||!confirm(`Delete “${task.title}”? Its uploaded files will remain in Materials.`)) return;
    state.tasks=state.tasks.filter(t=>t.id!==id); await saveState(); toast("Study item deleted."); return;
  }
  if(action==="complete") {
    const task=taskById(id); if(!task) return;
    task.completed=control.checked; task.completedAt=task.completed?new Date().toISOString():"";
    if(task.completed) ensureNextOccurrence(task);
    await saveState(); toast(task.completed?(task.repeatWeekly?"Completed. Next week’s item is ready.":"Marked complete."):"Moved back to your open items."); return;
  }
  if(action==="edit-course") { openCourseDialog(courseById(id)); return; }
  if(action==="delete-course") {
    const course=courseById(id); if(!course||!confirm(`Delete the course “${course.name}”? Its tasks and files will be kept as unassigned.`)) return;
    state.courses=state.courses.filter(c=>c.id!==id); state.tasks.forEach(t=>{if(t.courseId===id)t.courseId=""}); state.materials.forEach(m=>{if(m.courseId===id)m.courseId=""}); await saveState(); toast("Course removed. Its study items and files were kept."); return;
  }
  if(action==="course-tasks"||action==="go-course") { showPage("tasks"); setTimeout(()=>{const select=el("task-course-filter");if(select){select.value=id;render()}},0); return; }
  if(action==="open-file") { await openFile(id); return; }
  if(action==="delete-file") {
    const file=state.materials.find(m=>m.id===id); if(!file||!confirm(`Remove “${file.name}” from this browser?`)) return;
    await deleteFile(id); state.materials=state.materials.filter(m=>m.id!==id); state.tasks.forEach(t=>{t.attachments=(t.attachments||[]).filter(x=>x!==id)}); await saveState(); toast("File removed from this device."); return;
  }
  if(action==="export-data") { exportBackup(); return; }
  if(action==="toggle-notifications") { await enableNotifications(); return; }
  if(action==="focus-task") { const task=taskById(id); if(task){showPage("focus");toast(`Focus on: ${task.title}`)} return; }
});

document.addEventListener("dragover",(event)=>{
  const zone=event.target.closest(".upload-zone,.upload-drop");
  if(zone) { event.preventDefault(); zone.classList.add("drag-over"); }
});
document.addEventListener("dragleave",(event)=>{
  const zone=event.target.closest(".upload-zone,.upload-drop");
  if(zone&&!zone.contains(event.relatedTarget)) zone.classList.remove("drag-over");
});
document.addEventListener("drop",(event)=>{
  const zone=event.target.closest(".upload-zone,.upload-drop");
  if(!zone) return;
  event.preventDefault(); zone.classList.remove("drag-over");
  const files=[...event.dataTransfer.files];
  if(!files.length) return;
  openUploadDialog();
  const transfer=new DataTransfer();files.forEach(file=>transfer.items.add(file));
  el("file-input").files=transfer.files;
});

document.addEventListener("change",async(event)=>{
  if(event.target.id==="task-course-filter") render();
  if(event.target.id==="material-course-filter") render();
  if(event.target.id==="settings-reminder-time") { state.settings.reminderTime=event.target.value||"09:00"; await saveState(); toast("Reminder time updated."); }
  if(event.target.id==="settings-goal") { state.settings.dailyGoalMinutes=Math.max(15,Number(event.target.value)||120); await saveState(); toast("Study goal updated."); }
  if(event.target.id==="settings-focus-minutes") { state.settings.focusMinutes=Math.max(10,Number(event.target.value)||25); if(!timerRunning&&timerMode==="focus") timerRemaining=state.settings.focusMinutes*60; await saveState(); }
  if(event.target.id==="settings-break-minutes") { state.settings.breakMinutes=Math.max(3,Number(event.target.value)||5); await saveState(); }
  if(event.target.id==="import-file"&&event.target.files[0]) await importBackup(event.target.files[0]);
});

el("top-add-button").addEventListener("click",()=>openTaskDialog());
document.addEventListener("keydown",(event)=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k") { event.preventDefault(); el("global-search").focus(); }
  if(event.key==="Escape") el("global-search-results").hidden=true;
});
el("global-search").addEventListener("input",()=>{
  const query=el("global-search").value.trim().toLowerCase(),box=el("global-search-results");
  if(!query){box.hidden=true;return;}
  const found=[...state.tasks.filter(t=>`${t.title} ${courseName(t.courseId)} ${t.notes||""}`.toLowerCase().includes(query)).map(t=>({type:"Study item",title:t.title,sub:courseName(t.courseId),page:"tasks",id:t.id})),...state.courses.filter(c=>`${c.name} ${c.code||""}`.toLowerCase().includes(query)).map(c=>({type:"Course",title:c.name,sub:"Course",page:"courses",id:c.id})),...state.materials.filter(m=>`${m.name} ${courseName(m.courseId)}`.toLowerCase().includes(query)).map(m=>({type:"File",title:m.name,sub:courseName(m.courseId),page:"materials",id:m.id}))].slice(0,8);
  box.innerHTML=found.length?found.map(r=>`<button class="search-result" data-action="search-result" data-page="${r.page}" data-id="${esc(r.id)}"><span>${r.type==="Course"?"▦":r.type==="File"?"▱":"▤"}</span><span>${esc(r.title)}<small>${esc(r.type)} · ${esc(r.sub)}</small></span></button>`).join(""):`<div class="search-result">No matching courses, tasks, or files.</div>`;
  box.hidden=false;
});

el("task-list");

async function openFile(id) {
  try {
    const record=await getFile(id);
    if(!record?.blob) { toast("This file isn’t available in the browser where it was added."); return; }
    const url=URL.createObjectURL(record.blob),link=document.createElement("a");
    link.href=url; link.download=record.name; link.target="_blank"; link.rel="noopener"; document.body.append(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  } catch(error) { console.error(error); toast("Couldn’t open that file."); }
}

function exportBackup() {
  const backup={format:"study-buddy-backup",version:1,exportedAt:new Date().toISOString(),courses:state.courses,tasks:state.tasks.map(task=>({...task,attachments:[]})),settings:state.settings};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`study-buddy-backup-${dateKey()}.json`;a.click();URL.revokeObjectURL(url);toast("Backup downloaded. Uploaded files are stored separately on this device.");
}

async function importBackup(file) {
  try {
    const backup=JSON.parse(await file.text());
    if(backup.format!=="study-buddy-backup"||!Array.isArray(backup.tasks)||!Array.isArray(backup.courses)) throw new Error("Not a Study Buddy backup");
    if(!confirm(`Restore ${backup.tasks.length} study items and ${backup.courses.length} courses? Current course and task data will be replaced. Uploaded files will stay as they are.`)) return;
    state.tasks=backup.tasks;state.courses=backup.courses;state.settings={...state.settings,...backup.settings};await saveState();toast("Study Buddy backup restored.");
  } catch(error) { console.error(error);toast("That file wasn’t a valid Study Buddy backup."); }
  finally { el("import-file").value=""; }
}

async function enableNotifications() {
  if (state.settings.notifications) {
    state.settings.notifications=false;
    await saveState();
    toast("Deadline notifications are turned off.");
    return;
  }
  if(IN_EXTENSION) { state.settings.notifications=true;await saveState();toast("Extension reminders are ready at the selected time.");return; }
  if(!("Notification" in window)) { toast("This browser doesn’t support site notifications.");return; }
  const permission=await Notification.requestPermission();
  state.settings.notifications=permission==="granted";await saveState();
  toast(state.settings.notifications?"Daily reminders are enabled while this page is open.":"Notifications weren’t enabled. You can change this in browser settings.");
}

let webReminderTimeout=null;
function scheduleWebReminder() {
  clearTimeout(webReminderTimeout);
  if(IN_EXTENSION||!state.settings.notifications||Notification.permission!=="granted") return;
  const [hour,minute]=(state.settings.reminderTime||"09:00").split(":").map(Number),now=new Date(),next=new Date(now.getFullYear(),now.getMonth(),now.getDate(),hour,minute,0,0);
  if(next<=now) next.setDate(next.getDate()+1);
  webReminderTimeout=setTimeout(()=>{sendWebReminder();scheduleWebReminder()},next-now);
}
function sendWebReminder() {
  const soon=state.tasks.filter(t=>!t.completed&&t.dueDate&&dayDifference(t.dueDate)>=0&&dayDifference(t.dueDate)<=6);
  if(soon.length) new Notification("Study Buddy · upcoming deadlines",{body:soon.slice(0,4).map(t=>`${t.title} · ${courseName(t.courseId)} · ${dateLabel(t).text}`).join("\n"),icon:"icon.png"});
}

function timerText() { const minutes=Math.floor(timerRemaining/60),seconds=timerRemaining%60;return `${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`; }
function timerRender() { const display=el("timer-display");if(display)display.textContent=timerText();const toggle=el("timer-toggle");if(toggle)toggle.innerHTML=`${timerRunning?"Pause":"Start focus"} ${timerRunning?"Ⅱ":"▶"}`;const mode=$(".timer-mode");if(mode)mode.textContent=timerRunning?"IN PROGRESS":"READY WHEN YOU ARE"; }
function timerStart() {
  if(timerRunning){timerRunning=false;clearInterval(timerInterval);timerInterval=null;timerRender();return;}
  timerRunning=true;timerRender();
  timerInterval=setInterval(async()=>{
    timerRemaining--;timerRender();
    if(timerRemaining<=0){clearInterval(timerInterval);timerInterval=null;timerRunning=false;const finishedMode=timerMode;if(finishedMode==="focus"){state.sessions.push({id:uid(),date:dateKey(),minutes:Number(state.settings.focusMinutes)||25,mode:"Focus"});await saveState();timerMode="break";timerRemaining=(Number(state.settings.breakMinutes)||5)*60;toast("Focus block complete. Take a short break.");}else{timerMode="focus";timerRemaining=(Number(state.settings.focusMinutes)||25)*60;toast("Break is over. Ready for another focus block?");}render();}
  },1000);
}

document.addEventListener("click",(event)=>{
  if(event.target.id==="timer-toggle") timerStart();
  if(event.target.id==="timer-reset"){timerRunning=false;clearInterval(timerInterval);timerInterval=null;timerMode="focus";timerRemaining=(Number(state.settings.focusMinutes)||25)*60;timerRender();}
  if(event.target.id==="timer-break"){timerRunning=false;clearInterval(timerInterval);timerInterval=null;timerMode="break";timerRemaining=(Number(state.settings.breakMinutes)||5)*60;timerRender();}
});

async function init() {
  state=await readState();
  timerRemaining=(Number(state.settings.focusMinutes)||25)*60;
  if(IN_EXTENSION) await chrome.storage.local.set({studyBuddyState:state});
  if(!IN_EXTENSION&&"serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(()=>{});
  const initialPage=location.hash.slice(1);if(PAGE_NAMES[initialPage])page=initialPage;
  render();scheduleWebReminder();
}
init();
