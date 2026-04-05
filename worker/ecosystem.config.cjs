module.exports = {
  apps: [
    {
      name: "cleanstagram",
      script: "src/server.ts",
      interpreter: "tsx",
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
