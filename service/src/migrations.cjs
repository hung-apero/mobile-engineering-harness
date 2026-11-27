const { CORE } = require('./migrations-core.cjs');
const { FEATURES } = require('./migrations-features.cjs');

const MIGRATIONS = [...CORE, ...FEATURES];

module.exports = { MIGRATIONS };
