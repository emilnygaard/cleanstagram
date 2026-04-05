module.exports = {
  apps: [
    {
      name: "cleanstagram",
      script: "node_modules/.bin/tsx",
      args: "src/server.ts",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};
