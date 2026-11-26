const kv = require('../kv.cjs');
const store = require('./store.cjs');

const parkKey = id => `bug-park:${id}`;

function requestPark(db, batchId, now) {
  const batch = store.getBatch(db, batchId);
  if (!batch || store.FINISHED.includes(batch.state)) return false;
  kv.set(db, parkKey(batch.id), { at: now }, now);
  return true;
}

const parkRequested = (db, batchId) => kv.get(db, parkKey(batchId)) !== null;
const clearPark = (db, batchId) => kv.del(db, parkKey(batchId));

module.exports = { requestPark, parkRequested, clearPark };
