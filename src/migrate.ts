import { Pool } from "pg";
import { config } from "./config.js";
import { ensureSchema } from "./store.js";

if (!config.databaseUrl) {
  console.log("No DATABASE_URL configured; memory mode does not need migrations.");
  process.exit(0);
}
const pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false } });
await ensureSchema(pool);
await pool.end();
console.log("Gbolix AI Agent schema is ready.");
