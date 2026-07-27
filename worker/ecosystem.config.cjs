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
    {
      // Live browser session — a Chromium the owner can watch and take over when a
      // task hits a login or a captcha. Its own process for the same reason as the
      // browser worker above, and deliberately fenced against the SIP gateway on
      // this box: it refuses to start during a call and pauses when one arrives.
      // It touches no playout or VAD code, so the locked audio tuning is unchanged.
      name: 'alma-browser-live',
      script: 'src/browser/live-session.mjs',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '-r dotenv/config',
      max_memory_restart: '1200M',
      kill_timeout: 12000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 2000,
      max_restarts: 50,
      min_uptime: 10000,
      autorestart: true,
    },
    {
      // Self-hosted SIP gateway (NGS replacement, Phase 1). ARI + AudioSocket bridge
      // + NGS-shaped control API in front of the unchanged Gemini Live bot. Idle-safe
      // when SIP env is unset (control API 503s, never crash-loops). Needs `-r dotenv/config`.
      name: 'alma-sip-gateway',
      script: 'src/voice-relay/sip-gateway-service.mjs',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '-r dotenv/config',
      max_memory_restart: '400M',
      kill_timeout: 8000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 2000,
      max_restarts: 50,
      min_uptime: 10000,
      autorestart: true,
    },
  ],
}
