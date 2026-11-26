const FEATURES = [
  `CREATE TABLE specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '{}',
    figma TEXT,
    state TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL DEFAULT '{}',
    spec_sha TEXT,
    approved_sha TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX specs_project ON specs (project, state);
  CREATE TABLE spec_answers (
    spec_id INTEGER NOT NULL REFERENCES specs (id),
    qid TEXT NOT NULL,
    round INTEGER NOT NULL,
    choice TEXT,
    text TEXT NOT NULL DEFAULT '',
    "by" TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (spec_id, qid, round)
  );
  CREATE TABLE spec_rounds (
    spec_id INTEGER NOT NULL REFERENCES specs (id),
    round INTEGER NOT NULL,
    submitted_by TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    PRIMARY KEY (spec_id, round)
  );
  CREATE TABLE spec_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id INTEGER NOT NULL REFERENCES specs (id),
    qid TEXT NOT NULL,
    question TEXT NOT NULL,
    "by" TEXT NOT NULL,
    answer TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    at INTEGER NOT NULL
  );
  CREATE INDEX spec_chat_spec ON spec_chat (spec_id, qid);
  CREATE TABLE spec_tokens (
    hash TEXT PRIMARY KEY,
    spec_id INTEGER NOT NULL REFERENCES specs (id),
    purpose TEXT NOT NULL CHECK (purpose IN ('quiz', 'review')),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX spec_tokens_spec ON spec_tokens (spec_id, purpose);`,
  `CREATE TABLE jobs_next (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('probe', 'bug', 'feature', 'review', 'gate', 'build', 'spec', 'explain')),
    key TEXT NOT NULL, priority INTEGER NOT NULL CHECK (priority IN (0, 1, 2)), slots INTEGER NOT NULL CHECK (slots >= 1),
    slots_granted INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'starting', 'running', 'done', 'failed', 'parked')),
    attempt INTEGER NOT NULL DEFAULT 0, resumes INTEGER NOT NULL DEFAULT 0, resume INTEGER NOT NULL DEFAULT 0,
    session_id TEXT, pid INTEGER, pid_start INTEGER, log_file TEXT, log_offset INTEGER NOT NULL DEFAULT 0,
    last_event_at INTEGER, started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}', result TEXT, park_reason TEXT
  );
  INSERT INTO jobs_next SELECT * FROM jobs;
  DROP TABLE jobs;
  ALTER TABLE jobs_next RENAME TO jobs;
  CREATE UNIQUE INDEX jobs_one_open ON jobs (project, kind, key)
    WHERE state IN ('queued', 'starting', 'running', 'parked');
  CREATE INDEX jobs_state ON jobs (state, priority, id);`,
  `CREATE TABLE inbox (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    sent_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    acked_at INTEGER,
    action TEXT CHECK (action IN ('submit', 'answer', 'approve')),
    spec_id INTEGER,
    claimed_at INTEGER,
    outcome TEXT
  );
  CREATE INDEX inbox_pending ON inbox (acked_at, seen_at);
  CREATE TABLE inbox_posts (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    project TEXT NOT NULL,
    spec_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('quiz', 'review')),
    version TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX inbox_posts_spec ON inbox_posts (spec_id, kind, version);`,
  `CREATE TABLE jobs_next (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('probe', 'bug', 'feature', 'review', 'gate', 'build', 'spec', 'explain', 'e2e', 'uidiff')),
    key TEXT NOT NULL, priority INTEGER NOT NULL CHECK (priority IN (0, 1, 2)), slots INTEGER NOT NULL CHECK (slots >= 1),
    slots_granted INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'starting', 'running', 'done', 'failed', 'parked')),
    attempt INTEGER NOT NULL DEFAULT 0, resumes INTEGER NOT NULL DEFAULT 0, resume INTEGER NOT NULL DEFAULT 0,
    session_id TEXT, pid INTEGER, pid_start INTEGER, log_file TEXT, log_offset INTEGER NOT NULL DEFAULT 0,
    last_event_at INTEGER, started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}', result TEXT, park_reason TEXT
  );
  INSERT INTO jobs_next SELECT * FROM jobs;
  DROP TABLE jobs;
  ALTER TABLE jobs_next RENAME TO jobs;
  CREATE UNIQUE INDEX jobs_one_open ON jobs (project, kind, key)
    WHERE state IN ('queued', 'starting', 'running', 'parked');
  CREATE INDEX jobs_state ON jobs (state, priority, id);`,
];

module.exports = { FEATURES };
