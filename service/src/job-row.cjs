const parse = text => (text == null ? null : JSON.parse(text));

function toJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    project: row.project,
    kind: row.kind,
    key: row.key,
    priority: row.priority,
    slots: row.slots,
    slotsGranted: row.slots_granted,
    state: row.state,
    attempt: row.attempt,
    resumes: row.resumes,
    resume: row.resume === 1,
    sessionId: row.session_id,
    pid: row.pid,
    pidStart: row.pid_start,
    logFile: row.log_file,
    logOffset: row.log_offset,
    lastEventAt: row.last_event_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    payload: parse(row.payload),
    result: parse(row.result),
    parkReason: row.park_reason,
  };
}

module.exports = { toJob };
