import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

// 确保从脚本所在目录加载 .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '.env') });

import { getToken } from './src/auth.js';
import { getPersonLeaveToday } from './src/record.js';
import { buildSmartReport, buildDailyReport, sendNotify } from './src/notify.js';
import { generateSmartReport } from './src/kimi.js';

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
    closeThreshold: parseInt(process.env.CLOSE_THRESHOLD_MINUTES || '10', 10),
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
    // Kimi 配置
    kimiApiKey: process.env.KIMI_API_KEY || '',
    kimiModel: process.env.KIMI_MODEL || 'moonshot-v1-8k',
  };
}

// ---- AI 自主判断逻辑 ----

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

/**
 * 判断是否应该调用 Kimi
 * @param {Array} currentResults - 本次查询结果（核心人员）
 * @param {Array|null} lastResults - 上次查询结果（核心人员）
 * @param {number} lastKimiTime - 上次调用 Kimi 的时间戳
 * @param {Array} currentDeptResults - 本次部门同事查询结果
 * @param {Array|null} lastDeptResults - 上次部门同事查询结果
 * @returns {{ shouldCall: boolean, reason: string }}
 */
function shouldCallKimi(currentResults, lastResults, lastKimiTime, currentDeptResults = [], lastDeptResults = null) {
  const now = Date.now();

  // 从结果中提取关键信息
  const currentLeaveTimes = currentResults.map((r) => ({
    name: r.name,
    hasLeft: !!r.leaveInfo,
    leaveTime: r.leaveInfo?.time || null,
    recordCount: r.allRecords?.length || 0,
  }));

  const currentDeptLeaveTimes = currentDeptResults.map((r) => ({
    name: r.name,
    hasLeft: !!r.leaveInfo,
    leaveTime: r.leaveInfo?.time || null,
    recordCount: r.allRecords?.length || 0,
  }));

  // 如果没有上次结果，这是第一次查询
  if (!lastResults) {
    // 第一次查询：只要有任何打卡记录就调用 Kimi
    const anyRecords = currentLeaveTimes.some((r) => r.recordCount > 0);
    if (anyRecords) {
      return { shouldCall: true, reason: '首次查询且有打卡记录' };
    }
    // 完全没有记录，不调用
    return { shouldCall: false, reason: '首次查询，暂无任何打卡记录' };
  }

  const lastLeaveTimes = lastResults.map((r) => ({
    name: r.name,
    hasLeft: !!r.leaveInfo,
    leaveTime: r.leaveInfo?.time || null,
    recordCount: r.allRecords?.length || 0,
  }));

  const lastDeptLeaveTimes = lastDeptResults ? lastDeptResults.map((r) => ({
    name: r.name,
    hasLeft: !!r.leaveInfo,
    leaveTime: r.leaveInfo?.time || null,
    recordCount: r.allRecords?.length || 0,
  })) : [];

  // 条件 1：检测到新的下班记录（上次没下班，这次下班了）——核心人员
  for (let i = 0; i < currentLeaveTimes.length; i++) {
    if (currentLeaveTimes[i].hasLeft && !lastLeaveTimes[i].hasLeft) {
      return { shouldCall: true, reason: `${currentLeaveTimes[i].name} 刚刚下班` };
    }
  }

  // 条件 1b：检测到部门同事新的下班记录
  for (let i = 0; i < currentDeptLeaveTimes.length; i++) {
    if (currentDeptLeaveTimes[i].hasLeft && !lastDeptLeaveTimes[i]?.hasLeft) {
      return { shouldCall: true, reason: `部门同事 ${currentDeptLeaveTimes[i].name} 刚刚下班` };
    }
  }

  // 条件 2：距离上次 Kimi 调用超过 30 分钟，且有新数据
  const minInterval = 15 * 60 * 1000; // 最少间隔 15 分钟
  if (now - lastKimiTime < minInterval) {
    return { shouldCall: false, reason: `距上次调用不足 15 分钟` };
  }

  // 条件 3：有新的通行记录（记录数增加了）——核心人员
  let hasNewRecords = false;
  for (let i = 0; i < currentLeaveTimes.length; i++) {
    if (currentLeaveTimes[i].recordCount > lastLeaveTimes[i].recordCount) {
      hasNewRecords = true;
      break;
    }
  }

  // 条件 3b：部门同事有新记录
  if (!hasNewRecords) {
    for (let i = 0; i < currentDeptLeaveTimes.length; i++) {
      if (currentDeptLeaveTimes[i].recordCount > (lastDeptLeaveTimes[i]?.recordCount || 0)) {
        hasNewRecords = true;
        break;
      }
    }
  }

  if (!hasNewRecords) {
    // 数据完全没变化，不调用
    return { shouldCall: false, reason: '数据无变化' };
  }

  // 条件 4：有新记录 + 距上次超过 30 分钟
  if (now - lastKimiTime >= 30 * 60 * 1000) {
    return { shouldCall: true, reason: '距上次调用超 30 分钟且有新数据' };
  }

  // 条件 5：发现加班情况（>= 20:00 下班）——核心人员
  for (const person of currentLeaveTimes) {
    if (person.hasLeft && person.leaveTime) {
      const hour = parseInt(person.leaveTime.split(' ')[1]?.split(':')[0], 10);
      if (hour >= 20) {
        return { shouldCall: true, reason: `${person.name} 加班到很晚（${hour}:xx）` };
      }
    }
  }

  // 条件 5b：部门同事加班
  for (const person of currentDeptLeaveTimes) {
    if (person.hasLeft && person.leaveTime) {
      const hour = parseInt(person.leaveTime.split(' ')[1]?.split(':')[0], 10);
      if (hour >= 20) {
        return { shouldCall: true, reason: `部门同事 ${person.name} 加班到很晚（${hour}:xx）` };
      }
    }
  }

  // 条件 6：检查数据是否有实质变化（下班时间变了）——核心人员
  let hasSubstantialChange = false;
  for (let i = 0; i < currentLeaveTimes.length; i++) {
    if (currentLeaveTimes[i].leaveTime !== lastLeaveTimes[i].leaveTime) {
      hasSubstantialChange = true;
      break;
    }
  }

  // 条件 6b：部门同事下班时间变了
  if (!hasSubstantialChange) {
    for (let i = 0; i < currentDeptLeaveTimes.length; i++) {
      if (currentDeptLeaveTimes[i].leaveTime !== lastDeptLeaveTimes[i]?.leaveTime) {
        hasSubstantialChange = true;
        break;
      }
    }
  }

  if (hasSubstantialChange && now - lastKimiTime >= minInterval) {
    return { shouldCall: true, reason: '下班时间数据有更新' };
  }

  return { shouldCall: false, reason: '无显著变化，暂不调用' };
}

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
    state.lastKimiTime = 0;
    state.lastKimiContent = null;
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

    // 查询部门同事的通行记录（仅用于下班时间对比）
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

    // 合并所有人员数据用于 Kimi 分析
    const allResults = [...results, ...deptResults];

    // AI 判断是否需要重新调用 Kimi（频率限制）
    // 现在包括核心人员和部门同事的变化
    const { shouldCall, reason } = shouldCallKimi(
      results,
      state.lastResults || null,
      state.lastKimiTime || 0,
      deptResults,
      state.lastDeptResults || null
    );
    console.log(`[${timeStr}] AI 判断: ${shouldCall ? '✅ 调用 Kimi' : '⏭️ 跳过'} — ${reason}`);

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

    let report;

    if (config.kimiApiKey) {
      // 有 Kimi API Key：始终使用智能日报格式（表格 + 对比）
      if (shouldCall) {
        // 需要重新调用 Kimi 生成对比分析（传入全部人员数据）
        try {
          const kimiContent = await generateSmartReport(config.kimiApiKey, allResults, config.kimiModel);
          report = buildSmartReport(results, kimiContent);
          state.lastKimiTime = Date.now();
          state.lastKimiContent = kimiContent; // 缓存 Kimi 输出
          state.usedKimi = true;
        } catch (err) {
          console.warn(`[${timeStr}] Kimi 调用失败，使用上次内容或降级: ${err.message}`);
          // Kimi 失败时：用上次缓存的内容，或简单占位
          const fallbackContent = state.lastKimiContent || '📊 **下班时间对比**\n\n（AI 分析暂时不可用）';
          report = buildSmartReport(results, fallbackContent);
          state.usedKimi = false;
        }
      } else {
        // 不需要重新调用 Kimi：用上次缓存的内容继续生成智能日报
        const cachedContent = state.lastKimiContent || '📊 **下班时间对比**\n\n（暂无最新分析）';
        report = buildSmartReport(results, cachedContent);
        state.usedKimi = false;
        console.log(`[${timeStr}] 使用缓存的 Kimi 内容`);
      }
    } else {
      // 无 Kimi API Key：使用模板日报
      console.warn(`[${timeStr}] 未配置 Kimi API Key，使用模板日报`);
      report = buildDailyReport(results, config.closeThreshold);
      state.usedKimi = false;
    }

    console.log(`[${timeStr}] 日报生成完毕（${state.usedKimi ? 'Kimi 智能' : '模板'}模式）`);
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
  const forceKimi = process.argv.includes('--kimi'); // 强制调用 Kimi

  console.log('========================================');
  console.log('  AI 通行记录查询与下班提醒系统');
  console.log('========================================');

  if (isTest) {
    console.log('[Mode] 测试模式');
  }

  // Kimi 配置检查
  if (config.kimiApiKey) {
    console.log(`[Kimi] 已配置 API Key，模型: ${config.kimiModel}`);
  } else {
    console.warn('[Kimi] 未配置 KIMI_API_KEY，将使用模板日报');
    console.warn('[Kimi] 如需启用智能分析，请在 .env 中添加 KIMI_API_KEY');
  }

  const state = {};

  if (forceKimi) {
    // 强制模式：跳过 AI 判断，直接调用 Kimi
    console.log('[Mode] 强制 Kimi 模式');
    const token = await getToken(config.credentials);
    const results = [];
    for (const person of config.persons) {
      const result = await getPersonLeaveToday(token, person.personId, person.name, config.timeConfig);
      results.push(result);
    }

    // 查询部门同事
    let deptResults = [];
    if (config.deptPersons && config.deptPersons.length > 0) {
      for (const person of config.deptPersons) {
        const result = await getPersonLeaveToday(token, person.personId, person.name, config.timeConfig);
        deptResults.push(result);
      }
    }

    const allResults = [...results, ...deptResults];

    try {
      const kimiContent = await generateSmartReport(config.kimiApiKey, allResults, config.kimiModel);
      const report = buildSmartReport(results, kimiContent);
      await sendNotify(config.sendKey, report.title, report.content);
      console.log('✅ Kimi 智能日报生成完毕');
    } catch (err) {
      console.error('❌ Kimi 调用失败:', err.message);
    }
  } else {
    await runOnce(config, state);
  }

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
    console.log(`  部门同事: ${config.deptPersons.map((p) => p.name).join(', ')}（仅对比下班时间）`);
  }
  if (config.kimiApiKey) {
    console.log(`  Kimi 模型: ${config.kimiModel}`);
    console.log(`  AI 分析: 由系统智能判断调用时机`);
  } else {
    console.log(`  Kimi 分析: 未配置 API Key（使用模板日报）`);
  }
  console.log('========================================');

  // 跨轮次保持的状态
  const state = {
    lastResults: null,
    lastDeptResults: null,
    lastKimiTime: 0,
    lastDate: null, // 用于检测跨天，格式 "YYYY-MM-DD"
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
