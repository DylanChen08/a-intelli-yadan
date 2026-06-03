import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createServer } from 'http';
import dotenv from 'dotenv';

// 确保从脚本所在目录加载 .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '.env') });

import { getToken } from './src/auth.js';
import { getPersonLeaveToday } from './src/record.js';
import { getPersonWeekRecords, extractDailyTimes } from './src/weekly.js';
import { buildSmartReport, sendNotify } from './src/notify.js';

// ---- 全局运行时状态（HTTP 服务和守护循环共享） ----
const appState = {
  forceMode: false,
  forceIntervalSeconds: 20,
  lastRunTime: null,
  lastError: null,
  lastPushed: false,
  running: true,
};

// ---- 配置 ----
function loadConfig() {
  const personIds = (process.env.PERSON_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const personNames = (process.env.PERSON_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (personIds.length === 0) {
    throw new Error('请在 .env 文件中配置 PERSON_IDS');
  }

  // 名称不足时自动补齐
  while (personNames.length < personIds.length) {
    personNames.push(`人员${personIds.length}`);
  }

  return {
    credentials: {
      username: process.env.AUTH_USERNAME,
      password: process.env.AUTH_PASSWORD,
    },
    persons: personIds.map((id, i) => ({
      personId: id,
      name: personNames[i] || `人员${i + 1}`,
    })),
    // 部门同事（仅用于下班时间对比）
    deptPersons: (() => {
      const deptIds = (process.env.DEPT_PERSON_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
      const deptNames = (process.env.DEPT_PERSON_NAMES || '').split(',').map(s => s.trim()).filter(Boolean);
      if (deptIds.length === 0) return [];
      return deptIds.map((id, i) => ({
        personId: id,
        name: deptNames[i] || `同事${i + 1}`,
      }));
    })(),
    sendKey: process.env.SERVER_CHAN_SENDKEY || '',
    timeConfig: {
      startTime: process.env.QUERY_START_TIME || '',
      endTime: process.env.QUERY_END_TIME || '',
    },
    // 轮询间隔（分钟）
    intervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '10', 10),
    // 监控时段（小时）
    startHour: parseInt(process.env.MONITOR_START_HOUR || '8', 10),
    endHour: parseInt(process.env.MONITOR_END_HOUR || '24', 10),
    startMinute: parseInt(process.env.MONITOR_START_MINUTE || '30', 10),
  };
}

// ---- 数据变化检测 ----

/**
 * 检测数据是否有变化（用于决定是否推送）
 * @param {Array} currentResults - 本次查询结果
 * @param {Array|null} lastResults - 上次查询结果
 * @returns {boolean}
 */
function hasNewData(currentResults, lastResults) {
  // 第一次查询：有任何记录就算有数据
  if (!lastResults) {
    return currentResults.some((r) => r.allRecords && r.allRecords.length > 0);
  }

  // 对比每个人：记录数变化、下班时间变化、是否有新的下班记录
  for (let i = 0; i < currentResults.length; i++) {
    const curr = currentResults[i];
    const last = lastResults[i];

    // 记录总数变化
    const currCount = curr.allRecords?.length || 0;
    const lastCount = last.allRecords?.length || 0;
    if (currCount !== lastCount) return true;

    // 下班状态变化（从没下班 → 下班了）
    const currHasLeft = !!curr.leaveInfo;
    const lastHasLeft = !!last.leaveInfo;
    if (currHasLeft !== lastHasLeft) return true;

    // 下班时间变化
    if (currHasLeft && lastHasLeft && curr.leaveInfo.time !== last.leaveInfo.time) return true;
  }

  return false;
}

// ---- 核心逻辑 ----

/**
 * 单次查询+推送
 * @param {boolean} forcePush - 强制推送模式（跳过数据变化检测）
 */
async function runOnce(config, state = {}, forcePush = false) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const todayDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  console.log(`\n[${timeStr}] ====== 开始查询 ======`);

  // ---- 跨天检测：新的一天自动重置全部状态 ----
  if (state.lastDate && state.lastDate !== todayDate) {
    console.log(`[${timeStr}] 🌅 检测到新的一天（${state.lastDate} → ${todayDate}），重置状态`);
    state.lastResults = null;
    state.lastDeptResults = null;
    state.weekData = null;
    state.lastWeekDate = null;
  }
  state.lastDate = todayDate;

  try {
    // 登录
    const token = await getToken(config.credentials);

    // 查询每个人的通行记录
    const results = [];
    for (const person of config.persons) {
      const result = await getPersonLeaveToday(
        token,
        person.personId,
        person.name,
        config.timeConfig
      );
      results.push(result);
    }

    // 查询部门同事的通行记录
    let deptResults = [];
    if (config.deptPersons && config.deptPersons.length > 0) {
      for (const person of config.deptPersons) {
        const result = await getPersonLeaveToday(
          token,
          person.personId,
          person.name,
          config.timeConfig
        );
        deptResults.push(result);
      }
    }

    const allResults = [...results, ...deptResults];

    // ---- 查询近一周数据（每天只查一次，缓存复用） ----
    if (!state.weekData || state.lastWeekDate !== todayDate) {
      console.log(`[${timeStr}] 📅 查询近一周上下班数据...`);
      try {
        const allPersons = [...config.persons, ...(config.deptPersons || [])];
        const weekResults = [];
        for (const person of allPersons) {
          const { records } = await getPersonWeekRecords(token, person.personId, person.name, 7);
          weekResults.push({
            name: person.name,
            personId: person.personId,
            dailyTimes: extractDailyTimes(records, 7),
          });
        }
        state.weekData = weekResults;
        state.lastWeekDate = todayDate;
        console.log(`[${timeStr}] 📅 周数据已更新`);
      } catch (err) {
        console.warn(`[${timeStr}] ⚠️ 周数据查询失败: ${err.message}，本次推送跳过低对比`);
        state.weekData = null;
      }
    }

    // 检测数据是否有变化（核心人员 + 部门同事）
    const hasCoreDataChange = hasNewData(results, state.lastResults || null);
    const hasDeptDataChange = hasNewData(deptResults, state.lastDeptResults || null);
    const hasDataChange = forcePush || hasCoreDataChange || hasDeptDataChange;
    if (forcePush) {
      console.log(`[${timeStr}] 🔄 强制推送模式，无条件推送`);
    }
    console.log(`[${timeStr}] 数据变化: 核心=${hasCoreDataChange ? '有' : '无'}, 部门=${hasDeptDataChange ? '有' : '无'}${forcePush ? ', 强制推送' : ''}`);

    // 保存本次结果用于下次对比
    state.lastResults = results;
    state.lastDeptResults = deptResults;

    if (!hasDataChange) {
      console.log(`[${timeStr}] ⏭️ 数据无变化，跳过推送`);
      return { success: true, pushed: false, state };
    }

    // 生成报告并推送
    const report = buildSmartReport(results, allResults, state.weekData);
    console.log(`[${timeStr}] 日报生成完毕`);
    await sendNotify(config.sendKey, report.title, report.content);

    console.log(`[${timeStr}] ✅ 本次查询完成，已推送`);
    return { success: true, pushed: true, report, state };
  } catch (err) {
    console.error(`[${timeStr}] ❌ 执行出错:`, err.message);
    return { success: false, error: err.message, state };
  }
}

/**
 * 判断当前是否在监控时段内
 */
function isInMonitorWindow(config) {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const currentMinutes = h * 60 + m;
  const startMinutes = config.startHour * 60 + config.startMinute;
  const endMinutes = config.endHour * 60;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * 单次执行模式（--once / --test）
 */
async function runSingle() {
  const config = loadConfig();
  const isTest = process.argv.includes('--test');

  console.log('========================================');
  console.log('  AI 通行记录查询与下班提醒系统');
  console.log('========================================');

  if (isTest) {
    console.log('[Mode] 测试模式');
  }

  const state = {};
  await runOnce(config, state);

  if (isTest) {
    console.log('\n[Test] 测试模式完成');
  }
}

/**
 * 常驻守护模式（默认）
 * 短轮询检查，支持运行时动态切换间隔
 */
async function runDaemon() {
  const config = loadConfig();

  console.log('========================================');
  console.log('  AI 通行记录查询 - 守护模式');
  console.log('========================================');
  console.log(`  管理后台: http://localhost:${ADMIN_PORT}`);
  console.log(`  监控时段: ${String(config.startHour).padStart(2, '0')}:${String(config.startMinute).padStart(2, '0')} - ${String(config.endHour).padStart(2, '0')}:00`);
  console.log(`  默认间隔: 每 ${config.intervalMinutes} 分钟`);
  console.log(`  监控人员: ${config.persons.map((p) => p.name).join(', ')}`);
  if (config.deptPersons && config.deptPersons.length > 0) {
    console.log(`  部门同事: ${config.deptPersons.map((p) => p.name).join(', ')}`);
  }
  console.log('========================================');

  // 跨轮次保持的状态
  const state = {
    lastResults: null,
    lastDeptResults: null,
    lastDate: null,
    weekData: null,
    lastWeekDate: null,
  };

  let lastRunTime = 0;

  while (appState.running) {
    const now = Date.now();
    const effectiveIntervalMs = appState.forceMode
      ? appState.forceIntervalSeconds * 1000
      : config.intervalMinutes * 60 * 1000;

    if (now - lastRunTime >= effectiveIntervalMs) {
      // 正常模式受监控时段限制，强制模式不受限
      const inWindow = isInMonitorWindow(config);
      if (inWindow || appState.forceMode) {
        try {
          const result = await runOnce(config, state, appState.forceMode);
          appState.lastRunTime = new Date().toISOString();
          appState.lastPushed = result.pushed;
          appState.lastError = result.error || null;
        } catch (err) {
          appState.lastError = err.message;
          appState.lastRunTime = new Date().toISOString();
          console.error('[Daemon] 执行异常:', err.message);
        }
        lastRunTime = Date.now();
      } else {
        const d = new Date();
        console.log(`💤 当前不在监控时段（${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}），等待中...`);
      }
    }

    // 短轮询间隔（5 秒），确保能快速响应开关变化
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

// ---- 入口 ----
const isSingleRun = process.argv.includes('--once') || process.argv.includes('--test');
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3456', 10);

// ---- HTTP 管理后台 ----
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>考勤监控 - 管理后台</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1117; color: #e1e4e8; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    padding: 32px; width: 420px; max-width: 90vw;
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
  .row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 0; border-bottom: 1px solid #21262d;
  }
  .row:last-child { border-bottom: none; }
  .label { font-size: 15px; color: #c9d1d9; }
  .val { font-size: 14px; color: #8b949e; }
  .val.ok { color: #3fb950; }
  .val.err { color: #f85149; }

  /* Toggle Switch */
  .toggle { position: relative; display: inline-block; width: 52px; height: 28px; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
    background: #30363d; border-radius: 28px; transition: .3s;
  }
  .slider::before {
    content: ""; position: absolute; height: 22px; width: 22px;
    left: 3px; bottom: 3px; background: #c9d1d9; border-radius: 50%; transition: .3s;
  }
  input:checked + .slider { background: #238636; }
  input:checked + .slider::before { transform: translateX(24px); }

  .interval-input {
    background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
    color: #e1e4e8; padding: 6px 10px; width: 70px; font-size: 14px; text-align: center;
  }
  .interval-input:focus { outline: none; border-color: #58a6ff; }
  .unit { color: #8b949e; margin-left: 4px; font-size: 13px; }

  .status-bar {
    margin-top: 20px; padding: 12px; border-radius: 8px;
    background: #0d1117; border: 1px solid #21262d; font-size: 13px;
  }
  .status-bar p { margin: 4px 0; }
  .last-run { color: #8b949e; }
  .refresh-note { color: #484f58; font-size: 11px; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>🔍 考勤监控</h1>
  <div class="sub">yadan-report 管理后台</div>

  <div class="row">
    <span class="label">⚡ 强制推送</span>
    <label class="toggle">
      <input type="checkbox" id="forceToggle" onchange="toggleForce(this.checked)">
      <span class="slider"></span>
    </label>
  </div>

  <div class="row">
    <span class="label">⏱️ 推送间隔</span>
    <div>
      <input type="number" class="interval-input" id="intervalInput" value="20" min="5" max="3600" onchange="setInterval_(this.value)">
      <span class="unit">秒</span>
    </div>
  </div>

  <div class="status-bar">
    <p class="last-run">📡 上次运行: <span id="lastRun">-</span></p>
    <p>📊 上次推送: <span id="lastPush">-</span></p>
    <p>🟢 状态: <span id="svcStatus">运行中</span></p>
  </div>

  <div class="refresh-note">状态每 3 秒自动刷新</div>
</div>

<script>
const $ = id => document.getElementById(id);

async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    $('forceToggle').checked = d.forceMode;
    $('intervalInput').value = d.forceIntervalSeconds;
    $('lastRun').textContent = d.lastRunTime
      ? new Date(d.lastRunTime).toLocaleTimeString('zh-CN')
      : '待执行';
    $('lastPush').textContent = d.lastPushed ? '✅ 已推送' : '⏭️ 无推送';
    $('svcStatus').textContent = d.running ? '运行中' : '已停止';
  } catch(e) {}
}

async function toggleForce(on) {
  await fetch('/api/toggle', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ forceMode: on })
  });
  fetchStatus();
}

async function setInterval_(val) {
  const sec = parseInt(val) || 20;
  await fetch('/api/interval', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ seconds: Math.max(5, Math.min(3600, sec)) })
  });
  fetchStatus();
}

fetchStatus();
setInterval(fetchStatus, 3000);
</script>
</body>
</html>`;

function startAdminServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const path = u.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return;
    }

    // GET / — 管理页面
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ADMIN_HTML);
      return;
    }

    // GET /api/status
    if (req.method === 'GET' && path === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        forceMode: appState.forceMode,
        forceIntervalSeconds: appState.forceIntervalSeconds,
        lastRunTime: appState.lastRunTime,
        lastPushed: appState.lastPushed,
        lastError: appState.lastError,
        running: appState.running,
      }));
      return;
    }

    // POST /api/toggle
    if (req.method === 'POST' && path === '/api/toggle') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { forceMode } = JSON.parse(body);
          appState.forceMode = !!forceMode;
          console.log(`[Admin] 强制推送: ${appState.forceMode ? '开启' : '关闭'}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, forceMode: appState.forceMode }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // POST /api/interval
    if (req.method === 'POST' && path === '/api/interval') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { seconds } = JSON.parse(body);
          const sec = Math.max(5, Math.min(3600, parseInt(seconds) || 20));
          appState.forceIntervalSeconds = sec;
          console.log(`[Admin] 推送间隔设为: ${sec} 秒`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, forceIntervalSeconds: sec }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(ADMIN_PORT, () => {
    console.log(`\n🔧 管理后台已启动: http://localhost:${ADMIN_PORT}`);
  });

  return server;
}

// ---- 启动守护 + 管理后台 ----

if (isSingleRun) {
  // 单次执行模式：只启动管理后台用于测试
  startAdminServer();
  runSingle().catch((err) => {
    console.error('执行失败:', err.message);
    process.exit(1);
  });
} else {
  // 守护模式：管理后台 + 轮询并发运行
  startAdminServer();
  runDaemon().catch((err) => {
    console.error('守护进程异常退出:', err.message);
    process.exit(1);
  });
}
