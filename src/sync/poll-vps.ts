import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../db/config";

const TIMEOUT_MS = 10_000;
const INGEST_TIMEOUT_MS = 10 * 60_000;
const RUN_TS = join(import.meta.dir, "../ingest/run.ts");
// Fetch the AI key only for a requested ingest. The 30 s poll does not need it, and
// wrapping the poll in vault-run started the Bitwarden CLI (~190 MB) every 30 s.
const VAULT_RUN = join(homedir(), ".local/bin/vault-run");
const INGEST_CMD = [VAULT_RUN, "kharcha-mini.9router-key", "AI_API_KEY=password", "--", process.execPath, "run", RUN_TS];

function log(...parts: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

async function poll(url: string, token: string, done: boolean): Promise<{ sync: boolean }> {
  const res = await fetch(`${url}/api/mini/poll${done ? "?done=1" : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`status=${res.status}`);
  return (await res.json()) as { sync: boolean };
}

/**
 * Tell kharcha-web the mini is alive and run an ingest when it asked for
 * Sync now. launchd runs this every 30 s. Never throws.
 */
export async function pollVps(): Promise<void> {
  try {
    const url = (await getConfig("vps_push_url"))?.trim().replace(/\/+$/, "");
    const token = (await getConfig("vps_push_token"))?.trim();
    if (!url || !token) return;
    const { sync } = await poll(url, token, false);
    if (!sync) return;
    log("sync requested; running ingest");
    // ponytail: may overlap the 15-min launchd ingest; rows dedupe on source_message_guid.
    // A hung ingest would block every later poll (launchd won't start a second copy), so cap it.
    const proc = Bun.spawn(INGEST_CMD, { stdout: "inherit", stderr: "inherit", timeout: INGEST_TIMEOUT_MS, killSignal: "SIGKILL" });
    const code = await proc.exited;
    // Leave the request pending on failure; the next poll retries it.
    if (code !== 0) throw new Error(`requested ingest failed (exit ${code})`);
    await poll(url, token, true);
    log("sync done");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${new Date().toISOString()}] vps poll error:`, err instanceof Error ? err.message : err);
  }
}

if (import.meta.main) {
  await pollVps();
}
