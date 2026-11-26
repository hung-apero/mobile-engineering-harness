const MAX_LINE = 64 * 1024;

function readLines(socket, onLine, onTooLong, max = MAX_LINE) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.length > max) return onTooLong();
      if (line.trim()) onLine(line);
    }
    if (buffer.length > max) onTooLong();
  });
}

module.exports = { readLines, MAX_LINE };
