import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Loads a Google OAuth2Client from a credential directory.
 * Expects:
 *   <credDir>/gcp-oauth.keys.json  — OAuth client ID + secret
 *   <credDir>/credentials.json     — access/refresh tokens (written by auth flow)
 *
 * Throws a descriptive error if either file is missing.
 */
export function loadOAuthClient(credDir: string): OAuth2Client {
  const oauthPath = path.join(credDir, "gcp-oauth.keys.json");
  const credPath = path.join(credDir, "credentials.json");

  if (!fs.existsSync(oauthPath)) {
    throw new Error(
      `OAuth keys not found at ${oauthPath}. ` +
        `Copy gcp-oauth.keys.json there and run the auth command.`
    );
  }

  const keysContent = JSON.parse(fs.readFileSync(oauthPath, "utf8")) as Record<
    string,
    { client_id: string; client_secret: string }
  >;
  const keys = keysContent.installed ?? keysContent.web;
  if (!keys) {
    throw new Error(
      `Invalid OAuth keys file at ${oauthPath}. ` +
        `Expected "installed" or "web" key.`
    );
  }

  const client = new OAuth2Client(
    keys.client_id,
    keys.client_secret,
    "http://localhost:3000/oauth2callback"
  );

  if (!fs.existsSync(credPath)) {
    throw new Error(
      `OAuth credentials not found at ${credPath}. ` +
        `Run the auth command first (e.g. npx @gongrzhe/server-calendar-autoauth-mcp auth).`
    );
  }

  const credentials = JSON.parse(fs.readFileSync(credPath, "utf8")) as object;
  client.setCredentials(credentials);

  return client;
}

/** Resolves a credential directory from an env var with a default under $HOME. */
export function resolveCredDir(envVar: string, defaultSubdir: string): string {
  return process.env[envVar] ?? path.join(os.homedir(), defaultSubdir);
}
