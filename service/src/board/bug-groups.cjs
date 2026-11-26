const board = require('./store.cjs');
const { listVersions } = require('../bugs/store.cjs');
const { dayOf } = require('./activity.cjs');

const RANK = ['highest', 'high', 'medium', 'low', 'lowest'];
const UNKNOWN = 'Không rõ';

const rank = priority => {
  const index = RANK.indexOf(String(priority ?? '').toLowerCase());
  return index < 0 ? RANK.length : index;
};

function timeOf(ms, now) {
  const time = new Date(ms).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Saigon', hour: '2-digit', minute: '2-digit', hour12: false });
  if (dayOf(ms) === dayOf(now)) return time;
  const [, month, day] = dayOf(ms).split('-');
  return `${time} ngày ${day}/${month}`;
}

function syncLine(sync, now) {
  if (!sync) return 'chưa đồng bộ lần nào';
  if (!sync.ok) return `chưa đồng bộ được: ${sync.error ?? 'lỗi không rõ'}, lần cuối ${Number.isFinite(sync.lastOkAt) ? timeOf(sync.lastOkAt, now) : 'chưa có'}`;
  return `đồng bộ Jira lúc ${timeOf(sync.at, now)}${sync.capped ? ', còn nữa' : ''}`;
}

const byPriority = (a, b) => rank(a.priority) - rank(b.priority) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || a.key.localeCompare(b.key);

function groupsOf(bugs, loop) {
  const groups = new Map();
  for (const bug of [...bugs].sort(byPriority)) {
    const status = bug.status || UNKNOWN;
    if (!groups.has(status)) groups.set(status, []);
    groups.get(status).push({ ...bug, loop: loop.has(bug.key) });
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([status, items]) => ({ status, bugs: items }));
}

function bugBoard(db, project, now) {
  const loop = new Set(db.prepare('SELECT key FROM tickets WHERE project = ?').all(project).map(row => row.key));
  const rows = board.bugsOf(db, project);
  return listVersions(db, project).filter(item => item.state === 'open' && item.polling).map(({ version }) => ({
    version,
    sync: syncLine(board.syncOf(db, project, version), now),
    groups: groupsOf(rows.filter(row => row.version === version), loop),
  }));
}

module.exports = { bugBoard, syncLine };
