module.exports = {
  apps: [
    {
      name: 'aakriti-api',
      script: './server.js',
      // Single instance on purpose: Socket.IO rooms (live queue updates) live in
      // process memory and do not work across multiple cluster workers.
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000
    }
  ]
};
