import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const client = new PGlite();
const dir = fileURLToPath(new URL("./drizzle/", import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const f of files) {
  await client.exec(readFileSync(`${dir}${f}`, "utf8"));
}

const seqList = await client.query(
  "SELECT relname FROM pg_class WHERE relkind = 'S' ORDER BY relname"
);
console.log("sequences:", seqList.rows);

// Check the DO block from the coordinator's suggestion works and reports mappings.
const mapping = await client.query(`
  SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
  FROM pg_class s
  JOIN pg_depend d ON d.objid = s.oid
    AND d.classid = 'pg_class'::regclass
    AND d.refclassid = 'pg_class'::regclass
  JOIN pg_class t ON t.oid = d.refobjid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
  WHERE s.relkind = 'S'
`);
console.log("mapping:", mapping.rows);

// Insert a row into one seq-backed table (prompt_versions has version serial primary key per docs; use a known table).
await client.exec(`INSERT INTO agent_configs (name) VALUES ('x') ON CONFLICT DO NOTHING;`);

const dump = await client.dumpDataDir();
await client.close();

const t0 = Date.now();
const restored = new PGlite({ loadDataDir: dump });
await restored.waitReady;
const t1 = Date.now();
console.log("restore ms:", t1 - t0);

// Check current sequence values before reset (should show the SEQ_LOG_VALS jump).
const before = await restored.query(
  "SELECT sequence_name, last_value FROM information_schema.sequences s JOIN pg_sequences p ON p.sequencename = s.sequence_name"
).catch(async () => {
  // fallback simpler
  return restored.query("SELECT * FROM pg_sequences");
});
console.log("pg_sequences before reset:", before.rows);

const t2 = Date.now();
await restored.exec(`
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid
      AND d.classid = 'pg_class'::regclass
      AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S'
  LOOP
    EXECUTE format(
      'SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 0) + 1, false)',
      r.seq, r.col, r.tbl
    );
  END LOOP;
END $$;
`);
const t3 = Date.now();
console.log("reset ms:", t3 - t2);

const after = await restored.query("SELECT * FROM pg_sequences");
console.log("pg_sequences after reset:", after.rows);

await restored.close();
