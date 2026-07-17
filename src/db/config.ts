import { eq } from "drizzle-orm";
import { db } from "./connection";
import { config } from "./schema";

export async function getConfig(key: string): Promise<string | null> {
  const row = await db.select({ value: config.value }).from(config).where(eq(config.key, key)).get();
  return row?.value ?? null;
}

export async function setConfig(key: string, value: string): Promise<void> {
  await db
    .insert(config)
    .values({ key, value })
    .onConflictDoUpdate({
      target: config.key,
      set: { value },
    });
}
