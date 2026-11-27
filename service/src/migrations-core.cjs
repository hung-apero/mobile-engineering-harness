const CORE = [
  `CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('probe', 'bug', 'feature')),
    key TEXT NOT NULL,
    priority INTEGER NOT NULL CHECK (priority IN (0, 1, 2)),
    slots INTEGER NOT NULL CHECK (slots >= 1),
    slots_granted INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'queued'
      CHECK (state IN ('queued', 'starting', 'running', 'done', 'failed', 'parked')),
    attempt INTEGER NOT NULL DEFAULT 0,
    resumes INTEGER NOT NULL DEFAULT 0,
    resume INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    pid INTEGER,
    pid_start INTEGER,
    log_file TEXT,
    log_offset INTEGER NOT NULL DEFAULT 0,
    last_event_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    park_reason TEXT
  );
  CREATE UNIQUE INDEX jobs_one_open ON jobs (project, kind, key)
    WHERE state IN ('queued', 'starting', 'running', 'parked');
  CREATE INDEX jobs_state ON jobs (state, priority, id);`,
  `CREATE TABLE waits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('po', 'qa', 'dev')),
    subject TEXT NOT NULL,
    link TEXT,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
    opened_at INTEGER NOT NULL,
    resolved_at INTEGER,
    ping_count INTEGER NOT NULL DEFAULT 0,
    last_ping_at INTEGER,
    retry_at INTEGER
  );
  CREATE UNIQUE INDEX waits_one_open ON waits (project, role, subject) WHERE state = 'open';
  CREATE INDEX waits_open ON waits (project, state);`,
  `CREATE TABLE decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    job_id INTEGER,
    code TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    evidence TEXT NOT NULL,
    action TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX decisions_job ON decisions (job_id, id);
  CREATE TABLE missing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    situation TEXT NOT NULL,
    proposal TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    UNIQUE (project, situation)
  );
  CREATE TABLE sent_reports (
    kind TEXT NOT NULL CHECK (kind IN ('digest', 'weekly')),
    project TEXT NOT NULL,
    period TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (kind, project, period)
  );
  CREATE TABLE project_state (
    project TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    resumed_at INTEGER
  );`,
  `CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE versions (
    project TEXT NOT NULL,
    version TEXT NOT NULL,
    branch TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    baseline_at INTEGER,
    polling INTEGER NOT NULL DEFAULT 0 CHECK (polling IN (0, 1)),
    last_new_at INTEGER,
    last_poll_at INTEGER,
    build_failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project, version)
  );
  CREATE TABLE tickets (
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    version TEXT NOT NULL,
    priority INTEGER NOT NULL CHECK (priority IN (0, 1, 2, 3)),
    state TEXT NOT NULL DEFAULT 'accepted'
      CHECK (state IN ('accepted', 'batched', 'concluded', 'skipped', 'done', 'dev')),
    verdict TEXT,
    batch_id INTEGER,
    reopen_count INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project, key)
  );
  CREATE INDEX tickets_queue ON tickets (project, version, state, priority);
  CREATE TABLE batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    version TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('normal', 'highest')),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'running', 'done', 'abandoned')),
    keys TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    opened_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX batches_open ON batches (project, version, state);`,
  `CREATE TABLE jobs_next (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('probe', 'bug', 'feature', 'review', 'gate', 'build')),
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
  `CREATE TABLE effects (
    id TEXT PRIMARY KEY,
    batch_id INTEGER,
    state TEXT NOT NULL CHECK (state IN ('started', 'done')),
    result TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX effects_batch ON effects (batch_id);`,
];

module.exports = { CORE };
