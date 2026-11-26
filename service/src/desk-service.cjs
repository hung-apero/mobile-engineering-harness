const { loadProjects } = require('./projects.cjs');
const { createDesk } = require('./mcp/desk.cjs');
const { createDeskSocket } = require('./mcp/socket.cjs');
const { firstLine } = require('./redact.cjs');

async function startDeskSocket(ctx) {
  try {
    const desk = createDesk({
      db: ctx.db,
      bot: ctx.deskBot,
      facade: ctx.facade,
      projects: () => loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome }).projects,
      log: (event, fields) => ctx.log(event, fields),
    });
    const socket = createDeskSocket({ dzHome: ctx.dzHome, desk, log: (event, fields) => ctx.log(event, fields) });
    await socket.start();
    return socket;
  } catch (error) {
    ctx.log('desk-socket-failed', { error: firstLine(error) });
    return null;
  }
}

module.exports = { startDeskSocket };
