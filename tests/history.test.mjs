import test from 'node:test';
import assert from 'node:assert/strict';
import { revenueHistory } from '../scripts/lib.mjs';
import { chartSeries, chartSegments, dailyGrowth } from '../site/data-utils.js';

test('收益日报保留真实零、跳过空日报，限制时间区间并移除额外字段', () => {
  const history = revenueHistory({ list: [
    { date: '2026-10-10', revenue: '', extra: 'private' },
    { date: '2026-10-12', revenue: '530.04' },
    { date: '2026-10-11', revenue: '0', extra: 'private' },
    { date: '2026-10-13', revenue: '396.05' },
    { date: '2026-10-14', revenue: '99' },
    { date: 'not-a-date', revenue: '99' }
  ] }, '2026-10-01', '2026-10-13');
  assert.deepEqual(history, [{ date: '2026-10-11', revenue: 0 }, { date: '2026-10-12', revenue: 530.04 }, { date: '2026-10-13', revenue: 396.05 }]);
});

test('累计曲线从完整历史累加，截取窗口不重置金额，缺失日报不插值', () => {
  const history = [{ date: '2026-09-01', revenue: 12.5 }, { date: '2026-10-11', revenue: 5.2 }, { date: '2026-10-13', revenue: 3.1 }];
  assert.deepEqual(chartSeries(history, 'cumulative', 30, '2026-10-13'), [{ date: '2026-10-11', revenue: 17.7 }, { date: '2026-10-13', revenue: 20.8 }]);
  assert.equal(chartSegments(chartSeries(history, 'daily', 30, '2026-10-13'), 'daily').length, 2);
  assert.equal(dailyGrowth(history, '2026-10-13'), null);
  assert.equal(dailyGrowth([{ date: '2026-10-12', revenue: 100 }, { date: '2026-10-13', revenue: 80 }], '2026-10-13'), -20);
  assert.equal(dailyGrowth([{ date: '2026-10-12', revenue: 0 }, { date: '2026-10-13', revenue: 80 }], '2026-10-13'), null);
});
