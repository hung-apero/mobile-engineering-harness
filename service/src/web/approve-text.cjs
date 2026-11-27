const HEDGE = /(?<![\p{L}\p{N}])(?:nhưng|nhung|ngoại\s+trừ|ngoai\s+tru|trừ|tru)(?![\p{L}\p{N}])/iu;

function hedged(quote) {
  return HEDGE.test(String(quote).normalize('NFC'));
}

module.exports = { hedged };
