import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeOfficeRoutes, routeOfficeConnections, segmentBlocked } from '../public/office-routing.js';

const edge = (from, to, kind) => ({ from, to, kind, lane: kind === 'dispatch' ? 'dispatch' : 'return', channel: 'runner', count: 1, live: false, last: '' });
function overlaps(a, b, c, d) {
  const dx=b[0]-a[0],dy=b[1]-a[1];
  if(Math.abs(dx*(c[1]-a[1])-dy*(c[0]-a[0]))>0.01||Math.abs(dx*(d[1]-a[1])-dy*(d[0]-a[0]))>0.01)return false;
  const k=Math.abs(dx)>Math.abs(dy)?0:1;
  return Math.min(Math.max(a[k],b[k]),Math.max(c[k],d[k]))-Math.max(Math.min(a[k],b[k]),Math.min(c[k],d[k]))>0.01;
}
function crosses(a,b,c,d){
  if(Math.abs(a[0]-b[0])<0.01 && Math.abs(c[1]-d[1])<0.01)
    return a[0]>=Math.min(c[0],d[0])-0.01 && a[0]<=Math.max(c[0],d[0])+0.01 && c[1]>=Math.min(a[1],b[1])-0.01 && c[1]<=Math.max(a[1],b[1])+0.01;
  if(Math.abs(a[1]-b[1])<0.01 && Math.abs(c[0]-d[0])<0.01)return crosses(c,d,a,b);
  return false;
}
function verify(routes,nodes) {
  for(const r of routes){
    assert.ok(r.points.length<=4,'a corridor needs at most two right-angle turns');
    assert.doesNotMatch(r.d,/[QC]/,'no curved detours');
    for(let i=1;i<r.points.length;i++){
      const a=r.points[i-1],b=r.points[i];
      assert.ok(Math.abs(a[0]-b[0])<0.01 || Math.abs(a[1]-b[1])<0.01,'no diagonal shortcuts');
      assert.equal(segmentBlocked(a,b,Object.values(nodes)),false,`${r.key} crosses a workstation`);
    }
  }
  for(let i=0;i<routes.length;i++)for(let j=i+1;j<routes.length;j++){
    for(let a=1;a<routes[i].points.length;a++)for(let b=1;b<routes[j].points.length;b++){
      const segments=[routes[i].points[a-1],routes[i].points[a],routes[j].points[b-1],routes[j].points[b]];
      assert.equal(overlaps(...segments),false,'channels must not share a segment');
      assert.equal(crosses(...segments),false,'paired corridors must not cross');
    }
  }
}

test('same-kind dispatches merge, while the return remains independently directed',()=>{
  const merged=mergeOfficeRoutes([
    {...edge('manager','developer','dispatch'),count:5,last:'2026-10-14T01:00:00Z'},
    {...edge('developer','manager','report'),count:3,last:'2026-10-14T02:00:00Z'},
    {...edge('manager','developer','dispatch'),channel:'native',last:'2026-10-14T03:00:00Z',live:true},
  ]);
  assert.equal(merged.length,2);assert.equal(merged[0].count,6);assert.equal(merged[0].flowFrom,'manager');
  assert.deepEqual([...merged[0].channels],['runner','native']);assert.equal(merged[1].from,'developer');
});

test('open-plan hierarchy uses parallel right-angle corridors without diagonal shortcuts',()=>{
  const nodes={console:{x:300,y:20,w:300,h:108},manager:{x:370,y:200,w:160,h:150},writer:{x:120,y:460,w:144,h:150},developer:{x:380,y:460,w:144,h:150},reviewer:{x:640,y:460,w:144,h:150}};
  const connections=mergeOfficeRoutes([edge('console','manager','dispatch'),edge('manager','console','report'),...['writer','developer','reviewer'].flatMap((key,i)=>[edge('manager',key,'dispatch'),edge(key,'manager',['report','approval','error'][i])])]);
  const routes=routeOfficeConnections(connections,nodes,[],[],900,660);
  assert.equal(routes.length,8);verify(routes,nodes);
  for(const key of ['writer','reviewer']){
    const down=routes.find(r=>r.from==='manager'&&r.to===key),up=routes.find(r=>r.to==='manager'&&r.from===key);
    assert.equal(down.points.length,4);assert.equal(up.points.length,4);
    assert.equal(Math.abs(down.points[1][1]-up.points[1][1]),14,'the pair shares one corridor at a fixed distance');
  }
  assert.equal(routes.find(r=>r.from==='manager'&&r.to==='developer').points.length,2,'aligned stations do not get an unnecessary jog');
});

test('dispatch is screen-left and return screen-right for every generated role key',()=>{
  for(const [manager,employee] of [['a','z'],['z','a']]){
    const nodes={[manager]:{x:300,y:50,w:180,h:150},[employee]:{x:80,y:350,w:144,h:150}};
    for(const kind of ['approval','error','report']){
      const routes=routeOfficeConnections(mergeOfficeRoutes([edge(manager,employee,'dispatch'),edge(employee,manager,kind)]),nodes,[],[],600,600);
      const down=routes.find(r=>r.kind==='dispatch'),up=routes.find(r=>r.kind===kind);
      assert.equal(routes.length,2);assert.equal(up.points.at(-1)[0]-down.points[0][0],14);assert.equal(up.points[0][0]-down.points.at(-1)[0],14);
      verify(routes,nodes);
    }
  }
});

test('unknown or sealed endpoints never fabricate a line through a workstation',()=>{
  const nodes={a:{x:20,y:20,w:100,h:100},b:{x:20,y:300,w:100,h:100},obstacle:{x:0,y:180,w:200,h:50}};
  assert.deepEqual(routeOfficeConnections([edge('a','missing','dispatch')],nodes,[],[],300,450),[]);
  assert.deepEqual(routeOfficeConnections([edge('a','b','dispatch')],nodes,[],[],300,450),[]);
});

test('new employees expand one row and all 24 paired channels stay orthogonal and clear',()=>{
  const nodes={manager:{x:1000,y:100,w:360,h:150}};
  for(let i=0;i<12;i++)nodes['employee'+i]={x:70+i*190,y:430,w:144,h:150};
  const connections=mergeOfficeRoutes(Array.from({length:12},(_,i)=>[edge('manager','employee'+i,'dispatch'),edge('employee'+i,'manager','report')]).flat());
  const routes=routeOfficeConnections(connections,nodes,[],[],2400,650);
  assert.equal(routes.length,24);assert.equal(new Set(routes.map(r=>r.bundleKey)).size,12);verify(routes,nodes);
});
