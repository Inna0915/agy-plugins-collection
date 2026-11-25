'use strict';

const { getPrefs, setPrefs, toggleTokenFormat } = require('../lib/telemetry.cjs');

const arg = (process.argv[2] || '').trim().toLowerCase();
let res;
if (arg === 'm') {
  res = setPrefs({ tokenFormat: 'M' });
} else if (arg === 'raw' || arg === 'num' || arg === 'exact') {
  res = setPrefs({ tokenFormat: 'raw' });
} else if (arg === 'status') {
  res = getPrefs();
} else {
  res = toggleTokenFormat();
}

const label = res.tokenFormat === 'M' ? 'M（百万单位，如 6.85M）' : '纯数字（精确整数，如 6854320）';
console.log(`已切换全局 Token 显示格式为: ${label}`);
