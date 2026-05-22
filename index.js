import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

// 确保从脚本所在目录加载 .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '.env') });

import { getToken } from './src/auth.js';
import { getPersonLeaveToday } from './src/record.js';
import { getPersonWeekRecords, extractDailyTimes } from './src/weekly.js';
import { buildSmartReport, sendNotify } from './src/notify.js';

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
 */
async function runOnce(config, state = {}) {
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
    const hasDataChange = hasCoreDataChange || hasDeptDataChange;
    console.log(`[${timeStr}] 数据变化: 核心=${hasCoreDataChange ? '有' : '无'}, 部门=${hasDeptDataChange ? '有' : '无'}`);

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
 * 每隔 N 分钟查询一次，在监控时段内运行
 */
async function runDaemon() {
  const config = loadConfig();

  console.log('========================================');
  console.log('  AI 通行记录查询 - 守护模式');
  console.log('========================================');
  console.log(`  监控时段: ${String(config.startHour).padStart(2, '0')}:${String(config.startMinute).padStart(2, '0')} - ${String(config.endHour).padStart(2, '0')}:00`);
  console.log(`  查询间隔: 每 ${config.intervalMinutes} 分钟`);
  console.log(`  监控人员: ${config.persons.map((p) => p.name).join(', ')}`);
  if (config.deptPersons && config.deptPersons.length > 0) {
    console.log(`  部门同事: ${config.deptPersons.map((p) => p.name).join(', ')}`);
  }
  console.log('========================================');

  // 跨轮次保持的状态
  const state = {
    lastResults: null,
    lastDeptResults: null,
    lastDate: null, // 用于检测跨天，格式 "YYYY-MM-DD"
    weekData: null, // 近一周数据缓存
    lastWeekDate: null, // 上次查询周数据的日期
  };

  while (true) {
    if (isInMonitorWindow(config)) {
      await runOnce(config, state);
      console.log(`\n⏳ 下次查询: ${config.intervalMinutes} 分钟后`);
    } else {
      const now = new Date();
      const h = now.getHours();
      if (h >= config.endHour || h < config.startHour) {
        console.log(`💤 当前不在监控时段（${h}:${String(now.getMinutes()).padStart(2, '0')}），等待中...`);
      }
    }

    // 等待
    await new Promise((resolve) => setTimeout(resolve, config.intervalMinutes * 60 * 1000));
  }
}

// ---- 入口 ----
const isSingleRun = process.argv.includes('--once') || process.argv.includes('--test');

if (isSingleRun) {
  runSingle().catch((err) => {
    console.error('执行失败:', err.message);
    process.exit(1);
  });
} else {
  runDaemon().catch((err) => {
    console.error('守护进程异常退出:', err.message);
    process.exit(1);
  });
}
