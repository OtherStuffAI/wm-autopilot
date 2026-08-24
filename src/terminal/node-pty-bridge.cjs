const pty = require('node-pty');

let terminal = null;
let buffer = '';

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'start') {
    if (terminal) {
      try {
        terminal.kill();
      } catch {}
    }
    terminal = pty.spawn(message.shell || process.env.SHELL || '/bin/bash', [], {
      name: 'xterm-256color',
      cols: Number.isFinite(message.cols) ? message.cols : 80,
      rows: Number.isFinite(message.rows) ? message.rows : 24,
      cwd: message.cwd || process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });
    terminal.onData((data) => {
      send({ type: 'output', data: Buffer.from(data, 'utf8').toString('base64') });
    });
    terminal.onExit(({ exitCode, signal }) => {
      send({ type: 'exit', code: exitCode, signal: signal ?? null });
      terminal = null;
    });
    return;
  }
  if (message.type === 'input' && terminal && typeof message.data === 'string') {
    terminal.write(message.data);
    return;
  }
  if (message.type === 'resize' && terminal) {
    const cols = Number.isFinite(message.cols) ? message.cols : 80;
    const rows = Number.isFinite(message.rows) ? message.rows : 24;
    terminal.resize(cols, rows);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
});

process.on('exit', () => {
  if (terminal) {
    try {
      terminal.kill();
    } catch {}
  }
});
