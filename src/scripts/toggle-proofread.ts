import { ensureSchema } from "../db/bootstrap";
import { getConfig, setConfig } from "../db/config";

const KEY = "openrouter_proofread_enabled";

async function main(): Promise<void> {
  ensureSchema();

  const args = process.argv.slice(2);
  if (args.length !== 1 || !["on", "off", "status"].includes(args[0])) {
    // eslint-disable-next-line no-console
    console.error("usage: bun run toggle-proofread <on|off|status>");
    process.exit(1);
  }

  const command = args[0];

  if (command === "status") {
    const value = await getConfig(KEY);
    // eslint-disable-next-line no-console
    console.log(`${KEY}=${value ?? "<unset>"}`);
    return;
  }

  const value = command === "on" ? "true" : "false";
  await setConfig(KEY, value);
  // eslint-disable-next-line no-console
  console.log(`${KEY} set to ${value}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("toggle-proofread failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
