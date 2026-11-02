'use strict';

/**
 * 课堂在线评分应用 —— 后端服务（零依赖，纯 Node.js 内置模块）
 *
 * 数据模型（支持“多轮次 / 一学期多次上传作品”）：
 *  - 8 个“稳定小组”（第一组~第八组）：学生始终归属同一小组。
 *  - 多个“轮次”（round）：每轮次每个小组上传 1 个作品；学生给“除本组外”的 7 个作品打分。
 *  - 学生端默认对“当前轮次(active)”评分；教师可新建 / 切换 / 清空轮次。
 *  - 学期导出：把每个小组在每一轮的“作品均分”汇总，形成“小组学期得分”。
 *
 * 其他要点：
 *  - 内存存储 + 文件持久化（data/store.json），服务重启不丢数据。
 *  - SSE 实时推送教师大屏统计（当前轮次）。
 *  - 防自打：服务端强制学生不能给本组作品打分。
 *  - 防重复：以 (学生, 小组, 轮次) 为键 upsert，几秒内重复提交自动合并为一次。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function cn(n) {
  const s = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return s[n] || String(n);
}
function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function defaultState() {
  const groups = [];
  for (let i = 1; i <= 8; i++) groups.push({ id: 'g' + i, name: '第' + cn(i) + '组' });
  return {
    title: '课堂作品评分', maxScore: 100, adminKey: 'teacher',
    groups,
    rounds: [ { id: 'r1', name: '第1轮', createdAt: Date.now(), active: true, works: {}, scores: {} } ]
  };
}

// ---------- 内存状态 ----------
let state = defaultState();

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const obj = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      // 兼容旧版（config.groups 直接带作品）的数据迁移
      if (obj.config && Array.isArray(obj.config.groups) && !Array.isArray(obj.rounds)) {
        const groups = obj.config.groups.map((g, i) => ({ id: g.id || ('g' + (i + 1)), name: g.name || ('第' + cn(i + 1) + '组') }));
        const works = {};
        obj.config.groups.forEach(g => { if (g.id) works[g.id] = { workTitle: g.workTitle || '', workDesc: g.workDesc || '', workImage: g.workImage || '' }; });
        const scores = {};
        if (obj.scoresByStudent) {
          for (const k in obj.scoresByStudent) {
            const r = obj.scoresByStudent[k];
            scores[k] = { name: r.name, groupId: r.groupId, updatedAt: r.updatedAt || Date.now(), scores: r.scores || {} };
          }
        }
        state = {
          title: obj.config.title || '课堂作品评分',
          maxScore: obj.config.maxScore || 100,
          adminKey: obj.config.adminKey || 'teacher',
          groups,
          rounds: [ { id: 'r1', name: '第1轮', createdAt: Date.now(), active: true, works, scores } ]
        };
        console.log('[store] 已迁移旧版数据 → 第1轮');
      } else if (obj.state) {
        state = Object.assign(defaultState(), obj.state);
        if (!Array.isArray(state.groups) || !state.groups.length) state.groups = defaultState().groups;
        if (!Array.isArray(state.rounds) || !state.rounds.length) state.rounds = defaultState().rounds;
        console.log('[store] 已加载历史数据，轮次数=' + state.rounds.length + '，当前轮=' + (activeRound() ? activeRound().name : '无'));
      } else if (obj.config) {
        // 极旧结构兜底
        state = defaultState();
      }
    }
  } catch (e) { console.error('[store] 读取失败', e.message); }
}

let writeTimer = null, writePending = false;
function persist() {
  if (writeTimer) { writePending = true; return; }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const payload = JSON.stringify({ state });
    fs.writeFile(STORE_FILE, payload, (err) => {
      if (err) console.error('[store] 写入失败', err.message);
      if (writePending) { writePending = false; persist(); }
    });
  }, 400);
}

// ---------- 轮次工具 ----------
function activeRound() {
  let a = state.rounds.find(r => r.active);
  if (!a && state.rounds.length) { state.rounds[state.rounds.length - 1].active = true; a = state.rounds[state.rounds.length - 1]; }
  return a;
}
function getRound(id) { return state.rounds.find(r => r.id === id); }

// ---------- SSE ----------
const sseClients = new Set();
function broadcastStats() {
  const r = activeRound(); if (!r) return;
  const data = 'data: ' + JSON.stringify(computeStats(r)) + '\n\n';
  for (const res of sseClients) { try { res.write(data); } catch (e) { sseClients.delete(res); } }
}

// ---------- 统计（某轮次）----------
function computeStats(round) {
  const groups = state.groups.map(g => {
    const vals = [];
    for (const k in round.scores) {
      const rec = round.scores[k];
      if (rec.scores && typeof rec.scores[g.id] === 'number') vals.push(rec.scores[g.id]);
    }
    const count = vals.length;
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = count ? Math.round((sum / count) * 10) / 10 : 0;
    const w = round.works[g.id] || {};
    return {
      id: g.id, name: g.name, workTitle: w.workTitle || '', workDesc: w.workDesc || '', workImage: w.workImage || '',
      count, avg, min: count ? Math.min(...vals) : null, max: count ? Math.max(...vals) : null, scores: vals
    };
  });
  return {
    roundId: round.id, roundName: round.name, title: state.title, maxScore: state.maxScore,
    submittedStudents: Object.keys(round.scores).length,
    groupCount: state.groups.length, groups, updatedAt: Date.now()
  };
}

// 某小组在某一轮的“作品均分”（无打分则返回 null）
function groupRoundAvg(round, groupId) {
  const vals = [];
  for (const k in round.scores) {
    const rec = round.scores[k];
    if (rec.scores && typeof rec.scores[groupId] === 'number') vals.push(rec.scores[groupId]);
  }
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
}

function normName(n) { return String(n || '').trim().replace(/\s+/g, ' '); }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function csvCell(s) {
  const t = String(s == null ? '' : s);
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

// ---------- HTTP 工具 ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? path.join(PUBLIC_DIR, 'student.html')
    : pathname === '/teacher' ? path.join(PUBLIC_DIR, 'teacher.html')
    : path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  file = path.normalize(file);
  if (!file.startsWith(PUBLIC_DIR) && !file.startsWith(UPLOAD_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (pathname.startsWith('/uploads/')) {
        const uf = path.join(UPLOAD_DIR, pathname.replace(/^\/uploads\//, ''));
        if (uf.startsWith(UPLOAD_DIR) && fs.existsSync(uf)) {
          const ext = path.extname(uf);
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          res.end(fs.readFileSync(uf)); return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return;
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  try {
    // SSE（当前轮次）
    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      const r = activeRound();
      if (r) res.write('data: ' + JSON.stringify(computeStats(r)) + '\n\n');
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // 学生端：仅返回小组名单 + 当前轮次名（不含任何作品细节）
    if (pathname === '/api/groups' && req.method === 'GET') {
      const r = activeRound();
      return sendJSON(res, 200, {
        title: state.title,
        roundName: r ? r.name : '',
        groups: state.groups.map(g => ({ id: g.id, name: g.name }))
      });
    }

    // 教师端：全局配置（GET，供设置页初始化）
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJSON(res, 200, {
        title: state.title, maxScore: state.maxScore,
        groups: state.groups.map(g => ({ id: g.id, name: g.name }))
      });
    }

    // 学生端：返回“当前轮次中除本组外”的其余作品（服务端强制剔除本组，手机端根本收不到本组作品数据）
    if (pathname === '/api/works' && req.method === 'GET') {
      const r = activeRound();
      const gid = parsed.query.groupId || '';
      const validGroup = state.groups.find(g => g.id === gid);
      const others = (r && validGroup)
        ? state.groups
            .filter(g => g.id !== gid)
            .map(g => { const w = r.works[g.id] || {}; return { id: g.id, name: g.name, workTitle: w.workTitle || '', workDesc: w.workDesc || '', workImage: w.workImage || '' }; })
        : [];
      return sendJSON(res, 200, {
        title: state.title, roundName: r ? r.name : '', maxScore: state.maxScore,
        groupId: gid, totalNeeded: state.groups.length - 1, groups: others
      });
    }

    // 学生提交打分（打到当前轮次）
    if (pathname === '/api/score' && req.method === 'POST') {
      const r = activeRound();
      if (!r) return sendJSON(res, 200, { ok: false, code: 'NO_ROUND', msg: '老师尚未开启评分轮次' });
      const body = await readBody(req);
      const name = normName(body.name);
      const groupId = body.groupId;
      const scores = body.scores || {};
      if (!name) return sendJSON(res, 200, { ok: false, code: 'NAME_REQUIRED', msg: '请填写姓名' });
      const myGroup = state.groups.find(g => g.id === groupId);
      if (!myGroup) return sendJSON(res, 200, { ok: false, code: 'GROUP_INVALID', msg: '小组无效' });
      const valid = new Set(state.groups.map(g => g.id));
      const accepted = {};
      for (const wid in scores) {
        if (!valid.has(wid)) continue;
        if (wid === groupId) continue; // 不能给本组作品打分
        let v = scores[wid];
        if (typeof v === 'string') v = parseFloat(v);
        if (!isNum(v)) continue;
        v = Math.max(0, Math.min(state.maxScore, Math.round(v * 10) / 10));
        accepted[wid] = v;
      }
      if (Object.keys(accepted).length === 0) return sendJSON(res, 200, { ok: false, code: 'NO_SCORE', msg: '没有有效分数' });
      const key = name + '@' + groupId;
      const prev = r.scores[key];
      r.scores[key] = { name, groupId, updatedAt: Date.now(), scores: Object.assign(prev ? prev.scores : {}, accepted) };
      persist(); broadcastStats();
      return sendJSON(res, 200, {
        ok: true, msg: '提交成功', roundName: r.name,
        scoredCount: Object.keys(r.scores[key].scores).length,
        totalNeeded: state.groups.length - 1
      });
    }

    // 教师统计（默认当前轮次，可指定 roundId）
    if (pathname === '/api/stats' && req.method === 'GET') {
      const r = parsed.query.roundId ? getRound(parsed.query.roundId) : activeRound();
      if (!r) return sendJSON(res, 200, { error: 'NO_ROUND' });
      return sendJSON(res, 200, computeStats(r));
    }

    // 教师：轮次列表（含每轮提交人数与当前轮指示）
    if (pathname === '/api/rounds' && req.method === 'GET') {
      const list = state.rounds.map(r => ({
        id: r.id, name: r.name, createdAt: r.createdAt, active: !!r.active,
        submittedStudents: Object.keys(r.scores).length,
        workFilled: state.groups.filter(g => r.works[g.id] && (r.works[g.id].workTitle || r.works[g.id].workImage)).length,
        groupAvgs: state.groups.map(g => ({ id: g.id, name: g.name, avg: groupRoundAvg(r, g.id) })),
        works: r.works
      }));
      return sendJSON(res, 200, { title: state.title, maxScore: state.maxScore, groups: state.groups, rounds: list, activeRoundId: activeRound() ? activeRound().id : null });
    }

    // 教师上传作品图片（base64）
    if (pathname === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req);
      const img = body.image || '';
      const m = /^data:([^;]+);base64,(.+)$/.exec(img);
      if (!m) return sendJSON(res, 400, { ok: false, msg: '格式错误' });
      const mime = m[1];
      const extMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
      const ext = extMap[mime] || '.png';
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) return sendJSON(res, 400, { ok: false, msg: '图片过大' });
      const fname = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
      return sendJSON(res, 200, { ok: true, url: '/uploads/' + fname });
    }

    // 教师：新建轮次（需 key）
    if (pathname === '/api/round' && req.method === 'POST') {
      const key = parsed.query.key || '';
      if (key !== state.adminKey) return sendJSON(res, 403, { ok: false, msg: '口令错误' });
      const body = await readBody(req);
      const name = normName(body.name) || ('第' + (state.rounds.length + 1) + '轮');
      state.rounds.forEach(r => r.active = false); // 仅一个当前轮
      const nr = { id: uid('r'), name, createdAt: Date.now(), active: true, works: {}, scores: {} };
      state.rounds.push(nr);
      persist(); broadcastStats();
      return sendJSON(res, 200, { ok: true, round: nr, activeRoundId: nr.id });
    }

    // 教师：切换当前轮次（需 key）
    if (pathname === '/api/round/activate' && req.method === 'POST') {
      const key = parsed.query.key || '';
      if (key !== state.adminKey) return sendJSON(res, 403, { ok: false, msg: '口令错误' });
      const body = await readBody(req);
      const r = getRound(body.roundId);
      if (!r) return sendJSON(res, 200, { ok: false, msg: '轮次不存在' });
      state.rounds.forEach(x => x.active = (x.id === r.id));
      persist(); broadcastStats();
      return sendJSON(res, 200, { ok: true, activeRoundId: r.id });
    }

    // 教师：保存某轮次的作品（需 key）
    if (pathname === '/api/round/works' && req.method === 'POST') {
      const key = parsed.query.key || '';
      if (key !== state.adminKey) return sendJSON(res, 403, { ok: false, msg: '口令错误' });
      const body = await readBody(req);
      const r = getRound(body.roundId);
      if (!r) return sendJSON(res, 200, { ok: false, msg: '轮次不存在' });
      const w = body.works || {};
      state.groups.forEach(g => {
        const cur = r.works[g.id] || {};
        const nw = w[g.id] || {};
        r.works[g.id] = {
          workTitle: (nw.workTitle != null ? nw.workTitle : cur.workTitle || '').toString().trim(),
          workDesc: (nw.workDesc != null ? nw.workDesc : cur.workDesc || '').toString(),
          workImage: (nw.workImage != null ? nw.workImage : cur.workImage || '').toString()
        };
      });
      persist();
      return sendJSON(res, 200, { ok: true });
    }

    // 教师：清空某一轮次的打分（需 key）
    if (pathname === '/api/round/reset' && req.method === 'POST') {
      const key = parsed.query.key || '';
      if (key !== state.adminKey) return sendJSON(res, 403, { ok: false, msg: '口令错误' });
      const body = await readBody(req);
      const r = getRound(body.roundId);
      if (!r) return sendJSON(res, 200, { ok: false, msg: '轮次不存在' });
      r.scores = {};
      persist(); broadcastStats();
      return sendJSON(res, 200, { ok: true });
    }

    // 教师：全局设置（标题/满分/口令/小组名）（需 key）
    if (pathname === '/api/config' && req.method === 'POST') {
      const key = parsed.query.key || '';
      if (key !== state.adminKey) return sendJSON(res, 403, { ok: false, msg: '口令错误' });
      const body = await readBody(req);
      if (typeof body.title === 'string' && body.title.trim()) state.title = body.title.trim();
      if (isNum(body.maxScore) && body.maxScore > 0) state.maxScore = Math.min(1000, body.maxScore);
      if (typeof body.adminKey === 'string' && body.adminKey.trim()) state.adminKey = body.adminKey.trim();
      if (Array.isArray(body.groups)) {
        const ng = [];
        body.groups.forEach((g, i) => {
          const old = state.groups[i] || {};
          ng.push({ id: old.id || ('g' + (i + 1)), name: (g.name || ('第' + cn(i + 1) + '组')).trim() });
        });
        if (ng.length >= 2) state.groups = ng;
      }
      persist(); broadcastStats();
      return sendJSON(res, 200, { ok: true });
    }

    // 教师：清空全部打分（所有轮次，保留配置与轮次结构）（需 key）
    if (pathname === '/api/reset' && req.method === 'POST') {
      const key = parsed.query.key || '';
      if (key !== state.adminKey) return sendJSON(res, 403, { ok: false, msg: '口令错误' });
      state.rounds.forEach(r => r.scores = {});
      persist(); broadcastStats();
      return sendJSON(res, 200, { ok: true });
    }

    // 教师：导出 CSV（需 key）。mode=summary 学期小组汇总；mode=detail 各轮各作品评分明细
    if (pathname === '/api/export' && req.method === 'GET') {
      const key = parsed.query.key || '';
      if (key !== state.adminKey) { res.writeHead(403); res.end('口令错误'); return; }
      const mode = parsed.query.mode === 'detail' ? 'detail' : 'summary';
      let csv, filename;
      if (mode === 'summary') {
        csv = exportSummaryCSV();
        filename = '学期小组得分汇总.csv';
      } else {
        csv = exportDetailCSV();
        filename = '各轮各作品评分明细.csv';
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"'
      });
      // 加 BOM 便于 Excel 正确识别 UTF-8
      res.end('\uFEFF' + csv);
      return;
    }

    // 静态
    if (req.method === 'GET') return serveStatic(req, res, pathname);

    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    console.error('[server] 异常', e.message);
    if (!res.headersSent) sendJSON(res, 200, { ok: false, code: 'SERVER', msg: '稍后自动重试' });
    else try { res.end(); } catch (x) {}
  }
});

// ---------- 导出 ----------
function exportSummaryCSV() {
  const rounds = state.rounds;
  const header = ['小组'].concat(rounds.map(r => r.name + ' 均分')).concat(['学期均分', '学期总分']);
  const lines = [header.map(csvCell).join(',')];
  state.groups.forEach(g => {
    const avgs = rounds.map(r => groupRoundAvg(r, g.id));
    const valid = avgs.filter(v => v != null);
    const semAvg = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length * 10) / 10 : '';
    const semTotal = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) * 10) / 10 : '';
    lines.push([g.name].concat(avgs.map(v => v == null ? '' : v)).concat([semAvg, semTotal]).map(csvCell).join(','));
  });
  // 说明行
  lines.push('');
  lines.push(csvCell('说明：每列为该小组对应轮次“作品均分”；学期均分=各轮均分的平均；学期总分=各轮均分之和。').replace(/^"/, '').replace(/"$/, ''));
  return lines.join('\r\n');
}

function exportDetailCSV() {
  const header = ['轮次', '作品小组', '作品名称', '评分序号', '分数'];
  const lines = [header.map(csvCell).join(',')];
  state.rounds.forEach(r => {
    state.groups.forEach(g => {
      const w = r.works[g.id] || {};
      const vals = [];
      for (const k in r.scores) {
        const rec = r.scores[k];
        if (rec.scores && typeof rec.scores[g.id] === 'number') vals.push(rec.scores[g.id]);
      }
      vals.forEach((v, i) => {
        lines.push([r.name, g.name, w.workTitle || '', (i + 1), v].map(csvCell).join(','));
      });
    });
  });
  return lines.join('\r\n');
}

loadStore();
server.listen(PORT, HOST, () => {
  console.log('课堂评分应用已启动: http://' + HOST + ':' + PORT);
  console.log('学生端: /   教师大屏: /teacher');
});
