const discordLive = project => project?.live === true || project?.discord === true;

module.exports = { discordLive };
