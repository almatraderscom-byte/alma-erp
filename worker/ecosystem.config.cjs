/**
 * pm2 ecosystem — survives reboots after `pm2 startup` + `pm2 save`.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'agent-worker',
      cwd: __dirname,
      script: 'src/index.mjs',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
