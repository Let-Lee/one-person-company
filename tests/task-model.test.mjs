import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskGroups, actualRoleModel } from '../public/task-model.js';
const base = () => ({ runs: [{id:'r',roleKey:'m',status:'completed',createdAt:'1'}, {id:'e',roleKey:'e',kind:'team',teamTaskId:'t',status:'completed',createdAt:'2'}, {id:'i',roleKey:'m',kind:'inbox',managerMessageIds:['msg'],status:'completed',createdAt:'3'}], tasks:[{id:'t',title:'子任务',status:'blocked',origin:{runId:'r'},managerRoleKey:'m',employeeRoleKey:'e'}], messages:[{id:'msg',taskId:'t',kind:'blocked',runId:'e'}] });
test('one business goal contains dispatch, employee retry and manager reports without mutating history', () => {
 const d=base(), before=JSON.stringify(d); d.runs.push({...d.runs[1],id:'retry'});
 const copy=JSON.stringify(d), groups=taskGroups(d.runs,d);
 assert.equal(groups.length,1); assert.equal(groups[0].runs.length,4);assert.equal(groups[0].status,'blocked');assert.equal(JSON.stringify(d),copy);
 d.tasks[0].status='delivered';assert.equal(taskGroups(d.runs,d)[0].status,'delivered');
 d.tasks[0].status='accepted';assert.equal(taskGroups(d.runs,d)[0].status,'completed');
 assert.equal(taskGroups(d.runs,d,[{runId:'e',status:'pending'}])[0].status,'waiting_approval');
 assert.ok(before);
});
test('different goals in one session and same titles stay separate; shared inbox never merges roots', () => {
 const d=base();d.runs.push({id:'r2',roleKey:'m',sessionId:'same',prompt:'same',status:'completed',createdAt:'4'});
 d.tasks.push({id:'t2',origin:{runId:'r2'},status:'accepted'}); d.messages.push({id:'msg2',taskId:'t2'});d.runs[2].managerMessageIds.push('msg2');
 const groups=taskGroups(d.runs,d);assert.equal(groups.length,2);assert.ok(groups.every(g=>g.sharedProcess));
});
test('missing parents, cycles and legacy data remain visible, without invented relationships', () => {
 const runs=[{id:'a',kind:'inbox',managerMessageIds:['missing']},{id:'b',teamTaskId:'old'},{id:'c',parentRunId:'d'},{id:'d',parentRunId:'c'}];
 const groups=taskGroups(runs);assert.ok(groups.some(g=>g.runs.some(r=>r.id==='a')));assert.ok(groups.some(g=>g.runs.some(r=>r.id==='b')));assert.ok(groups.some(g=>g.runs.some(r=>r.id==='c')));assert.ok(groups.some(g=>g.runs.some(r=>r.id==='d')));
});
test('actual model requires evidence of the selected turn, never requested model or role defaults', () => {
 const role={key:'e',defaults:{model:'configured'}};assert.equal(actualRoleModel(role).text,'未运行');
 const run={roleKey:'e',turnId:'t',model:'requested',startedAt:'1',createdAt:'1',status:'completed'};
 assert.equal(actualRoleModel(role,[run]).text,'待确认');
 run.actualModel={id:'actual',turnId:'t',source:'turn/start'};assert.equal(actualRoleModel(role,[run]).text,'上次 · actual');
 const current={...run,createdAt:'2',status:'running',turnId:'new',actualModel:null};assert.equal(actualRoleModel(role,[run,current]).text,'待确认');
 current.actualModel={id:'another',turnId:'new',source:'turn/started'};assert.equal(actualRoleModel(role,[run,current]).text,'another');
});

test('runtime-returned per-turn model persists in run and API summaries, independently of requested defaults', async t => {
 const { EventEmitter } = await import('node:events'), fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
 const {createWorkbench}=await import('../src/app.mjs');
 class Runtime extends EventEmitter {
  snapshot(){return {status:'ready'}} async ensureStarted(){} isLoaded(){return true}
  async startThread(p){return {thread:{id:'thread-model'},cwd:p.cwd,model:'session-default'}}
  async setThreadName(){} async listSkills(){return {data:[]}}
  async startTurn(){return {turn:{id:'turn-model',model:'runtime-actual',modelProvider:'returned-route'}}}
 }
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'t016-model-'));
 const ctx=createWorkbench({env:{YEWANG_DATA_DIR:tmp+'/data',YEWANG_WORKSPACES_ROOT:tmp+'/ws',YEWANG_COMPANY_ROOT:tmp+'/company'},runtime:new Runtime()});
 t.after(()=>{clearTimeout(ctx.store.timer);fs.rmSync(tmp,{recursive:true,force:true})});
 const role=ctx.workbench.saveLocalRole({name:'模型来源样例',title:'开发'}),ses=await ctx.workbench.createSession({roleKey:role.key});
 const run=await ctx.workbench.dispatch({sessionId:ses.id,prompt:'isolated metadata fixture',model:'requested-model'});
 await new Promise(resolve=>setImmediate(resolve));
 const stored=ctx.workbench.getRun(run.id);assert.equal(stored.actualModel.id,'runtime-actual');assert.equal(stored.actualModel.turnId,stored.turnId);assert.equal(stored.actualModel.source,'turn/start');
 assert.equal(actualRoleModel(role,ctx.workbench.listRuns()).text,'runtime-actual');ctx.store.save();assert.equal(JSON.parse(fs.readFileSync(ctx.store.file)).runs[run.id].actualModel.id,'runtime-actual');
});
