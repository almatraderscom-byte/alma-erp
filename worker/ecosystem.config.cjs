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
  ],
}
