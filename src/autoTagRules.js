const crypto = require('crypto');

// 自動標籤規則：檔名或完整路徑符合關鍵字 / 正規表示式時，加上指定的標籤。
// 規則存在 config.json（與資料庫後端無關）；掃描到新增或變動的影片時自動套用，也可在設定頁對全部影片套用。
const FIELDS = ['filename', 'path'];
const TYPES = ['keyword', 'regex'];

function normalizeRule(rule = {}) {
  return {
    id: typeof rule.id === 'string' && rule.id ? rule.id : crypto.randomUUID(),
    field: FIELDS.includes(rule.field) ? rule.field : 'filename',
    type: TYPES.includes(rule.type) ? rule.type : 'keyword',
    pattern: String(rule.pattern || '').trim(),
    tags: Array.isArray(rule.tags)
      ? [...new Set(rule.tags.map(t => String(t).trim()).filter(Boolean))]
      : [],
    enabled: rule.enabled !== false
  };
}

// 規則有問題時回傳錯誤訊息，沒問題回傳 null
function validateRule(rule) {
  if (!rule.pattern) return '請輸入要比對的文字';
  if (rule.tags.length === 0) return '請至少指定一個標籤';
  if (rule.type === 'regex') {
    try {
      new RegExp(rule.pattern, 'i');
    } catch (error) {
      return `正規表示式有誤：${error.message}`;
    }
  }
  return null;
}

function fileNameOf(filepath) {
  return String(filepath).split(/[\\/]/).pop();
}

// 編譯成比對函式；停用或有錯的規則略過
function compileRules(rules) {
  const compiled = [];
  for (const raw of rules || []) {
    const rule = normalizeRule(raw);
    if (!rule.enabled || validateRule(rule)) continue;
    const test = rule.type === 'regex'
      ? (() => { const re = new RegExp(rule.pattern, 'i'); return (text) => re.test(text); })()
      : (() => { const needle = rule.pattern.toLowerCase(); return (text) => text.toLowerCase().includes(needle); })();
    compiled.push({
      rule,
      matches: (filepath) => test(rule.field === 'path' ? String(filepath) : fileNameOf(filepath))
    });
  }
  return compiled;
}

function matchTags(compiled, filepath) {
  const tags = new Set();
  for (const { rule, matches } of compiled) {
    if (matches(filepath)) rule.tags.forEach(tag => tags.add(tag));
  }
  return [...tags];
}

// 對 refs（[{ filepath, fingerprint }]）套用規則，回傳 { matchedVideos, added }。
// 標籤表沒有的新標籤由 backfillOrphanTags() 補進「未分類」，才會出現在篩選列與標籤管理
async function applyRules(database, rules, refs) {
  const compiled = compileRules(rules);
  if (compiled.length === 0) return { matchedVideos: 0, added: 0 };

  const fingerprintsByTag = new Map();
  let matchedVideos = 0;
  for (const ref of refs) {
    if (!ref.fingerprint) continue;
    const tags = matchTags(compiled, ref.filepath);
    if (tags.length === 0) continue;
    matchedVideos++;
    for (const tag of tags) {
      if (!fingerprintsByTag.has(tag)) fingerprintsByTag.set(tag, []);
      fingerprintsByTag.get(tag).push(ref.fingerprint);
    }
  }

  let added = 0;
  for (const [tag, fingerprints] of fingerprintsByTag) {
    added += await database.addTagToVideos(fingerprints, tag);
  }
  if (added > 0 && typeof database.backfillOrphanTags === 'function') {
    await database.backfillOrphanTags();
  }
  return { matchedVideos, added };
}

// 預覽每條規則（含停用的）會符合幾部影片，不寫入資料庫
function previewRules(rules, refs) {
  return (rules || []).map(raw => {
    const rule = normalizeRule(raw);
    const error = validateRule(rule);
    if (error) return { id: rule.id, matched: 0, error };
    const [compiled] = compileRules([{ ...rule, enabled: true }]);
    const matched = refs.reduce((n, ref) => n + (compiled.matches(ref.filepath) ? 1 : 0), 0);
    return { id: rule.id, matched, error: null };
  });
}

module.exports = { normalizeRule, validateRule, compileRules, matchTags, applyRules, previewRules };
