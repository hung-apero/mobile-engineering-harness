const PEOPLE = ['po', 'poBackup', 'qa', 'devOnCall'];

const unique = list => [...new Set(list.filter(Boolean))].sort();

function byChannel(projects) {
  const map = new Map();
  for (const project of projects) {
    if (!project.enabled || !project.channel) continue;
    map.set(project.channel, [...(map.get(project.channel) ?? []), project]);
  }
  return map;
}

const peopleOf = projects => unique(projects.flatMap(project => PEOPLE.map(name => project.people[name])));

function allowedByChannel(projects) {
  return new Map([...byChannel(projects)].map(([channel, list]) => [channel, peopleOf(list)]));
}

function liveChannels(projects) {
  return [...byChannel(projects)].filter(([, list]) => list.every(project => project.live === true)).map(([channel]) => channel).sort();
}

function channelKeys(projects) {
  return Object.fromEntries([...byChannel(projects)].map(([channel, list]) => [channel, list.map(project => project.key).sort()]));
}

function buildAccess(projects) {
  const groups = {};
  for (const [channel, allowFrom] of allowedByChannel(projects)) {
    if (allowFrom.length === 0) throw new Error(`kênh ${channel} không có người được phép gửi`);
    groups[channel] = { requireMention: false, allowFrom };
  }
  const active = [...byChannel(projects).values()].flat();
  return {
    dmPolicy: 'allowlist',
    allowFrom: unique(active.map(project => project.people.devOnCall)),
    groups,
    pending: {},
    ackReaction: '',
    replyToMode: 'first',
    textChunkLimit: 2000,
    chunkMode: 'newline',
  };
}

module.exports = { buildAccess, allowedByChannel, liveChannels, channelKeys };
