const HOSTS = ['appdistribution.firebase.google.com', 'appdistribution.firebase.dev', 'console.firebase.google.com'];
const LINES = [/Share this release with testers[^:\n]{0,80}:\s*(https:\/\/\S+)/g, /View this release in the Firebase console[^:\n]{0,40}:\s*(https:\/\/\S+)/g];
const SAFE = /^https:\/\/[A-Za-z0-9\-._~:/?&=%#+]{1,400}$/;

function safeLink(text) {
  const clean = text.replace(/[.,;)\]]+$/, '');
  if (!SAFE.test(clean) || !URL.canParse(clean)) return null;
  const url = new URL(clean);
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && HOSTS.includes(url.hostname) ? clean : null;
}

function firebaseLink(log) {
  if (typeof log !== 'string') return null;
  for (const pattern of LINES) {
    const link = [...log.matchAll(pattern)].map(match => safeLink(match[1])).filter(Boolean).at(-1);
    if (link) return link;
  }
  return null;
}

module.exports = { firebaseLink };
