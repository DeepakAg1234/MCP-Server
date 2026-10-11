import { defineRailway, postgres, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const db = postgres("Postgres");

  const app = service("google-workspace-mcp", {
    start: "npm start",
    healthcheck: "/readyz",
    healthcheckTimeout: 60,
    replicas: 1,
    env: {
      TRANSPORT: "http",
      TOKEN_STORE: "postgres",
      TOKEN_STORE_DATABASE_URL: db.env.DATABASE_URL,
      LOG_CONTENT: "false",
      METRICS_ENABLED: "false",
      PUBLIC_BASE_URL: preserve(),
      GOOGLE_REDIRECT_URI: preserve(),
      GOOGLE_OAUTH_CLIENT_ID: preserve(),
      GOOGLE_OAUTH_CLIENT_SECRET: preserve(),
      TOKEN_ENCRYPTION_KEY: preserve(),
      MCP_AUTHORIZATION_SERVER: preserve(),
      MCP_DEV_BEARER_SHA256: preserve(),
      NODE_ENV: preserve(),
    },
  });

  return project("google-workspace-mcp", {
    resources: [db, app],
  });
});
