import { createServer } from "node:net";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { devBearerHash } from "../../src/auth/mcp-principal.js";
import { startHttpServer } from "../../src/mcp/http.js";
import { invocationContext } from "../../src/domain/context.js";
import { createOperationId } from "../../src/domain/ids.js";
import { metricsAccess } from "../../src/observability/metrics.js";
import { fakeIdToken, testConfig } from "../helpers.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

const ACCESS = "ya29.callback-access-token-marker";
const REFRESH = "refresh-callback-token-marker";

describe("http routes", () => {
  it("serves health, rejects a down store, and hides tokens on the OAuth callback", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const token = "owner-token";
    const other = "other-token";
    const http = await startHttpServer({
      config: testConfig({
        transport: "http",
        host: "127.0.0.1",
        port,
        publicBaseUrl: base,
        googleRedirectUri: `${base}/oauth/google/callback`,
        allowSingleReplicaSqlite: true,
        mcpDevBearerSha256: `${devBearerHash(token)}|tenant-a|user-a,${devBearerHash(other)}|tenant-a|user-b`,
        metricsEnabled: true,
        nodeEnv: "development",
      }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: ACCESS,
            refresh_token: REFRESH,
            expires_in: 3600,
            id_token: fakeIdToken({ sub: "google-sub", email: "ada@example.com", name: "Ada" }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const healthBody = await health.text();
      expect(healthBody).toBe(JSON.stringify({ status: "ok" }));
      expect(healthBody).not.toMatch(/ada@example.com/);

      const ctx = invocationContext({
        operationId: createOperationId(),
        tenantId: "tenant-a",
        userId: "user-a",
        transport: "streamable-http",
      });
      const begun = await http.app.accounts.begin(ctx, { capabilities: ["gmail.send"] }, `${base}/oauth/google/callback`);
      expect(begun.ok).toBe(true);
      if (!begun.ok) return;
      const state = new URL(begun.result.authorization_url).searchParams.get("state");
      const foreign = await fetch(`${base}/oauth/google/callback?code=code-1&state=${state}`, {
        headers: { authorization: `Bearer ${other}` },
      });
      expect(foreign.status).toBe(400);
      expect(await http.app.store.listAccounts("tenant-a", "user-b")).toEqual([]);

      const ok = await fetch(`${base}/oauth/google/callback?code=code-1&state=${state}`);
      const page = await ok.text();
      expect(ok.status).toBe(200);
      expect(page).toContain("ada@example.com");
      expect(page).not.toContain(ACCESS);
      expect(page).not.toContain(REFRESH);
      expect(page).not.toContain("code-1");
      const accounts = await http.app.store.listAccounts("tenant-a", "user-a");
      expect(accounts).toHaveLength(1);
      expect(await http.app.store.readRefreshCiphertext("tenant-a", "user-a", accounts[0]?.accountId ?? "")).not.toBeNull();

      const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
      const document = (await metadata.json()) as { scopes_supported: string[]; resource: string };
      expect(document.scopes_supported).toEqual(["tools.call"]);
      expect(document.resource).toBe(base);

      http.app.store.ping = async () => {
        throw new Error("down");
      };
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "unavailable" });

      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toMatch(/text\/plain/);
    } finally {
      await http.close();
    }
  });

  it("rejects a token whose audience does not match", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const issuer = "https://issuer.example";
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.alg = "RS256";
    jwk.kid = "test-key";
    const http = await startHttpServer({
      config: testConfig({
        transport: "http",
        host: "127.0.0.1",
        port,
        publicBaseUrl: base,
        googleRedirectUri: `${base}/oauth/google/callback`,
        allowSingleReplicaSqlite: true,
        mcpAuthorizationServer: issuer,
        mcpResourceAudience: `${base}/mcp`,
        nodeEnv: "development",
      }),
      jwks: createLocalJWKSet({ keys: [jwk] }),
    });
    try {
      const token = await new SignJWT({ scope: "tools.call" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer)
        .setAudience("https://other.example/mcp")
        .setSubject("user-a")
        .setExpirationTime("2h")
        .sign(privateKey);
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/invalid_token/);
    } finally {
      await http.close();
    }
  });
});

describe("metrics access", () => {
  it("is localhost-only until a metrics token is set", () => {
    expect(metricsAccess({ remoteAddress: "127.0.0.1", metricsToken: "", authorization: undefined })).toBe("ok");
    expect(metricsAccess({ remoteAddress: "10.0.0.8", metricsToken: "", authorization: undefined })).toBe("forbidden");
    expect(metricsAccess({ remoteAddress: "10.0.0.8", metricsToken: "secret", authorization: "Bearer secret" })).toBe("ok");
    expect(metricsAccess({ remoteAddress: "127.0.0.1", metricsToken: "secret", authorization: undefined })).toBe("unauthorized");
  });
});
