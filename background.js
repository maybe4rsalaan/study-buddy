const ALARM_NAME = "study-buddy-daily-check";
const DEFAULT_TIME = "09:00";
const emptyState = { tasks: [], courses: [], materials: [], sessions: [], settings: { reminderTime: DEFAULT_TIME, focusMinutes: 25, breakMinutes: 5, dailyGoalMinutes: 120, notifications: true } };

const localDateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const dateFromKey = (key) => { const [y,m,d] = key.split("-").map(Number); return new Date(y,m-1,d); };
const dayDiff = (dueDate,today) => Math.round((dateFromKey(dueDate)-dateFromKey(today))/86400000);
const uid = () => crypto.randomUUID();

async function ensureWeeklyOccurrences(state) {
  const today=localDateKey(),ids=new Set(state.tasks.map(task=>task.id));
  let changed=false;
  for (const task of [...state.tasks]) {
    if(!task.repeatWeekly||!task.dueDate) continue;
    const seriesId=task.seriesId||task.id;
    let next=dateFromKey(task.dueDate);next.setDate(next.getDate()+7);
    while(localDateKey(next)<=today){
      const dueDate=localDateKey(next),id=`${seriesId}-${dueDate}`;
      if(!ids.has(id)){
        state.tasks.push({...task,id,seriesId,dueDate,completed:false,completedAt:"",attachments:[]});
        ids.add(id);changed=true;
      }
      next.setDate(next.getDate()+7);
    }
  }
  if(changed) await chrome.storage.local.set({studyBuddyState:state});
}

async function nextReminder() {
  const {studyBuddyState}=await chrome.storage.local.get("studyBuddyState");
  const reminderTime=studyBuddyState?.settings?.reminderTime||DEFAULT_TIME;
  const [hour,minute]=reminderTime.split(":").map(Number),now=new Date();
  const next=new Date(now.getFullYear(),now.getMonth(),now.getDate(),hour,minute,0,0);
  if(next<=now)next.setDate(next.getDate()+1);
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME,{when:next.getTime()});
}

async function dailyCheck() {
  const {studyBuddyState}=await chrome.storage.local.get("studyBuddyState");
  const state=studyBuddyState||emptyState;
  await ensureWeeklyOccurrences(state);
  if(state.settings?.notifications!==false){
    const today=localDateKey();
    const soon=(state.tasks||[]).filter(task=>!task.completed&&task.dueDate&&dayDiff(task.dueDate,today)>=0&&dayDiff(task.dueDate,today)<=6);
    if(soon.length){
      const courses=new Map((state.courses||[]).map(course=>[course.id,course.name]));
      const lines=soon.slice(0,4).map(task=>`${task.title}${courses.get(task.courseId)?` · ${courses.get(task.courseId)}`:""} · ${dayDiff(task.dueDate,today)===0?"due today":dayDiff(task.dueDate,today)===1?"due tomorrow":`due in ${dayDiff(task.dueDate,today)} days`}`);
      const extra=soon.length>lines.length?`\n…and ${soon.length-lines.length} more`:"";
      await chrome.notifications.create(`study-buddy-${today}`,{type:"basic",iconUrl:"icon.png",title:"Study Buddy · upcoming deadlines",message:`${lines.join("\n")}${extra}`,priority:1});
    }
  }
  await nextReminder();
}

async function migrateOrInitialize() {
  const existing=await chrome.storage.local.get(["studyBuddyState","tasks","reminderTime"]);
  if(existing.studyBuddyState) return;
  let state=structuredClone(emptyState);
  if(Array.isArray(existing.tasks)&&existing.tasks.length){
    const courseNames=[...new Set(existing.tasks.map(task=>task.course).filter(Boolean))];
    state.courses=courseNames.map((name,index)=>({id:`migration-course-${index}-${uid()}`,name,code:"",color:["blue","violet","mint","amber","rose"][index%5],description:""}));
    state.tasks=existing.tasks.map(task=>({id:task.id||uid(),seriesId:task.repeatWeekly?(task.seriesId||task.id):"",title:task.title||"Study item",courseId:state.courses.find(course=>course.name===task.course)?.id||"",type:"Assignment",dueDate:task.dueDate||"",priority:"normal",effort:60,notes:"",attachments:[],repeatWeekly:Boolean(task.repeatWeekly),completed:Boolean(task.completed)}));
    state.settings.reminderTime=existing.reminderTime||DEFAULT_TIME;
  }
  await chrome.storage.local.set({studyBuddyState:state});
}

chrome.runtime.onInstalled.addListener(async()=>{await migrateOrInitialize();await nextReminder();});
chrome.runtime.onStartup.addListener(nextReminder);
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL("index.html")}));
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM_NAME)dailyCheck();});
chrome.runtime.onMessage.addListener(message=>{if(message?.type==="stateChanged")nextReminder();});
