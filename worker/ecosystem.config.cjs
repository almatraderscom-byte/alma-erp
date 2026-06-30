module.exports = {
  apps: [
    {
      name: 'alma-agent-worker',
      script: 'src/index.mjs',
      cwd: __dirname,
      interpreter: 'node',
      max_memory_restart: '768M',
      kill_timeout: 8000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 2000,
      max_restarts: 50,
      min_uptime: 10000,
      autorestart: true,
    },
    {
      // Phase A: isolated Playwright browser-agent worker. Separate process so
      // Chromium memory/crashes never take down the main agent worker.
      name: 'alma-browser-worker',
      script: 'src/browser/service.mjs',
      cwd: __dirname,
      interpreter: 'node',
      max_memory_restart: '1200M',
      kill_timeout: 12000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 2000,
      max_restarts: 50,
      min_uptime: 10000,
      autorestart: true,
    },
  ],
}
