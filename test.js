'use strict';
// 课堂评分应用 自测：多轮次 + 60 并发 + 去重 + 自打防护 + 导出
const BASE = 'http://127.0.0.1:3000';
const KEY = 'teacher';
const GROUPS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];

function post(path, body) {
  return fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
}
function getj(path) { return fetch(BASE + path).then(r => r.json()); }
function setWorks(roundId, suffix) {
  const works = {};
  GROUPS.forEach((g, i) => { works[g] = { workTitle: '作品' + (i + 1) + suffix, workDesc: '', workImage: '' }; });
  return post('/api/round/works?key=' + KEY, { roundId, works });
}

async function main() {
  let pass = true;
  const log = (...a) => console.log(...a);
  const assert = (cond, msg) => { if (!cond) { pass = false; log('  ✗ ' + msg); } else log('  ✓ ' + msg); };

  await post('/api/reset?key=' + KEY, {});
  let rounds = (await getj('/api/rounds')).rounds;
  const r1 = rounds[0].id;
  await setWorks(r1, '(第1轮)');
  log('[准备] 默认轮次 r1=' + r1 + '，已填作品');

  // 记录真实提交到 r1 的分数（含探针），用于校验平均分
  const real1 = {}; GROUPS.forEach(g => real1[g] = []);
  let submitted1 = 0;

  // —— 自打防护探针（先跑，记入账本）——
  const onlySelf = await post('/api/score', { name: '仅自打', groupId: 'g1', scores: { g1: 99 } });
  log('[4A] 只给本组打分：'); assert(!onlySelf.ok && onlySelf.code === 'NO_SCORE', '被拒绝 (NO_SCORE)');
  const g1Before = (await getj('/api/stats?roundId=' + r1)).groups.find(g => g.id === 'g1').count;
  const mix = await post('/api/score', { name: '混交生', groupId: 'g1', scores: { g1: 99, g2: 80, g3: 70 } });
  const g1After = (await getj('/api/stats?roundId=' + r1)).groups.find(g => g.id === 'g1').count;
  log('[4B] 混交本组+他组：'); assert(g1Before === g1After && g1After === 0, '本组(g1)计数不变(仍为0)，他组被接收');
  real1.g2.push(80); real1.g3.push(70); submitted1 += 1;

  // —— 60 名学生并发提交 r1 ——
  const N = 60;
  const students = [];
  const studentScores = [];
  for (let i = 0; i < N; i++) students.push({ name: '学生' + (i + 1), groupId: GROUPS[i % 8] });
  const tasks = students.map(async (s) => {
    const scores = {};
    GROUPS.forEach(w => { if (w !== s.groupId) { const v = Math.floor(Math.random() * 101); scores[w] = v; real1[w].push(v); } });
    studentScores.push({ name: s.name, groupId: s.groupId, scores });
    return post('/api/score', { name: s.name, groupId: s.groupId, scores });
  });
  const res1 = await Promise.all(tasks);
  submitted1 += N;
  log('[1] 60 路并行提交：'); assert(res1.every(r => r.ok), '全部 ok=true');

  let st = await getj('/api/stats?roundId=' + r1);
  const rec1 = st.groups.reduce((a, g) => a + g.count, 0);
  log('[2] 第1轮统计：'); assert(st.submittedStudents === submitted1, '已提交人数=' + st.submittedStudents + ' (期望 ' + submitted1 + ')');
  assert(rec1 === 420 + 2, '总记录=' + rec1 + ' (期望 422：60×7 + 混交生2)');

  // —— 去重：10 人重复提交“相同有效分数”两次，应只计一次（值不变、记录不增）——
  const dup = studentScores.slice(0, 10);
  await Promise.all(dup.map(s =>
    post('/api/score', { name: s.name, groupId: s.groupId, scores: s.scores })
      .then(() => post('/api/score', { name: s.name, groupId: s.groupId, scores: s.scores }))
  ));
  const st2 = await getj('/api/stats?roundId=' + r1);
  log('[3] 重复提交(相同有效分数×2)后：'); assert(st2.submittedStudents === submitted1, '已提交人数不变=' + st2.submittedStudents);
  assert(st2.groups.reduce((a, g) => a + g.count, 0) === rec1, '总记录不变=' + st2.groups.reduce((a, g) => a + g.count, 0));

  // —— 平均分校验（r1）——
  let avgOk = true;
  st.groups.forEach(g => {
    const exp = real1[g.id];
    const expAvg = exp.length ? Math.round(exp.reduce((a, b) => a + b, 0) / exp.length * 10) / 10 : 0;
    if (Math.abs(g.avg - expAvg) >= 0.05) avgOk = false;
  });
  log('[5] 第1轮平均分：'); assert(avgOk, '与账本完全一致');

  // —— 第二轮 ——
  const nr = await post('/api/round?key=' + KEY, { name: '第2轮' });
  const r2 = nr.round.id;
  await setWorks(r2, '(第2轮)');
  await post('/api/round/activate?key=' + KEY, { roundId: r2 });
  log('[6] 新建并激活第2轮 r2=' + r2);

  const real2 = {}; GROUPS.forEach(g => real2[g] = []);
  await Promise.all(students.map(async (s) => {
    const scores = {};
    GROUPS.forEach(w => { if (w !== s.groupId) { const v = Math.floor(Math.random() * 101); scores[w] = v; real2[w].push(v); } });
    return post('/api/score', { name: s.name, groupId: s.groupId, scores });
  }));
  const stR2 = await getj('/api/stats?roundId=' + r2);
  const rec2 = stR2.groups.reduce((a, g) => a + g.count, 0);
  log('[7] 第2轮统计：'); assert(stR2.submittedStudents === 60, '已提交人数=60');
  assert(rec2 === 420, '总记录=420');

  // —— 轮次隔离：r1 不被 r2 影响 ——
  const stR1again = await getj('/api/stats?roundId=' + r1);
  log('[8] 第1轮隔离：'); assert(stR1again.submittedStudents === submitted1, 'r1 仍=' + stR1again.submittedStudents);

  // —— 导出：汇总 ——
  const summary = await fetch(BASE + '/api/export?key=' + KEY + '&mode=summary').then(r => r.text());
  const slines = summary.split('\r\n').filter(l => l.trim() && !l.startsWith('说明'));
  const sheader = slines[0].split(',');
  log('[9] 汇总CSV：'); assert(sheader.length === 5, '表头列数=5 (小组+2轮+学期均分+学期总分) → ' + sheader.join('|'));
  assert(slines.length - 1 === 8, '数据行=8 (8 小组)');

  // —— 导出：明细 ——
  const detail = await fetch(BASE + '/api/export?key=' + KEY + '&mode=detail').then(r => r.text());
  const dlines = detail.split('\r\n').filter(l => l.trim());
  log('[10] 明细CSV：'); assert(dlines.length === rec1 + rec2 + 1, '行数=' + dlines.length + ' (表头1+两轮记录 ' + (rec1 + rec2) + ')');

  // —— 当前轮次端点 ——
  const grp = await getj('/api/groups');
  log('[11] /api/groups：'); assert(grp.roundName === '第2轮' && grp.groups.length === 8, '当前轮次=第2轮, 小组=8');

  log('\n==== 自测结果：', pass ? '全部通过 ✅' : '存在异常 ❌', '====');
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error('测试异常', e); process.exit(1); });
