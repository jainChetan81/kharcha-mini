import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const KEYCHAIN_SERVICE = "kharcha-mini-api-token";
const KEYCHAIN_ACCOUNT = "mini";

function runSecurity(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("security", args, {
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status ?? null,
  };
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Store the API bearer token in the macOS Keychain. Overwrites any existing
 * entry with the same service/account pair (idempotent).
 */
export function storeToken(token: string): void {
  const result = runSecurity([
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
    token,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `Keychain store failed for ${KEYCHAIN_SERVICE}: ${result.stderr || result.stdout}`,
    );
  }
}

let cachedToken: string | null = null;

/**
 * Read the API bearer token from the macOS Keychain. Cached in-memory for the
 * process lifetime so repeated requests don't shell out.
 */
export function readToken(): string | null {
  if (cachedToken !== null) return cachedToken;
  const result = runSecurity([
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  if (result.status !== 0) {
    return null;
  }
  cachedToken = result.stdout;
  return cachedToken;
}

export function clearCachedToken(): void {
  cachedToken = null;
}

export { KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT };
