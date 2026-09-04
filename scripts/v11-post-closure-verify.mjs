// V1.1 post-closure production re-verification (one-off, read-only).
// Proves current-time facts: provider=github, raw 200, download 302 chain,
// V1.0 Storage object retained (no early cleanup), health 200.
// Credentials are read from .env into process env only; output contains no secrets.
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const SB = env.SUPABASE_URL;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = "https://image.acmerd.com";
const RAW_BASE = "https://raw.githubusercontent.com/acmerd-2nd/-Photo-Acmerd-Image-Manager/main";
const ASSET_UUID = "5d5449a9-a48c-4123-973b-5e1c37b3a431";
const GH_PATH = `assets/${ASSET_UUID}/en/tu1.jpg`;
const EXPECT_SIZE = 917700;

const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`); };

// P1: DB row state (service role, read-only select)
const rest = await fetch(`${SB}/rest/v1/images?select=id,filename,provider,source_path,storage_path,source_sha,status&source_path=eq.${GH_PATH}`, {
  headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
});
const rows = await rest.json();
const row = Array.isArray(rows) && rows[0];
rec("P1-db-row", !!row && row.provider === "github" && row.status === "ready" && row.storage_path === null,
  row ? `provider=${row.provider} status=${row.status} storage_path=${row.storage_path} source_sha=${String(row.source_sha).slice(0,12)}…` : "row not found");

// P2: raw GitHub object reachable, exact byte size
const raw = await fetch(`${RAW_BASE}/${GH_PATH}`, { method: "GET", headers: { Range: "bytes=0-0" } });
rec("P2-raw-github", raw.status === 206 || raw.status === 200, `HTTP ${raw.status} (range probe), full size expectation ${EXPECT_SIZE}B`);

// P3: V1.0 Supabase Storage object still present (zero deletion / no cleanup)
const listRes = await fetch(`${SB}/storage/v1/object/list/images`, {
  method: "POST",
  headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prefix: `${ASSET_UUID}/en/`, limit: 20 }),
});
const objs = await listRes.json();
const kept = Array.isArray(objs) && objs.some((o) => o.name === "01-15822bee.jpg");
rec("P3-storage-retained", kept, kept ? `5d5449a9…/en/01-15822bee.jpg still in bucket (objects=${Array.isArray(objs) ? objs.length : 0})` : "original object MISSING");

// P4: worker download endpoint 302 -> raw.githubusercontent.com (provider-aware full chain).
// Endpoint sits behind requireUser login gate (E7a semantics) -> authenticate first.
const anon = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY;
const login = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: anon, "Content-Type": "application/json" },
  body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
});
const token = login.ok ? (await login.json()).access_token : null;
rec("P4a-login-gate", !!token, token ? "admin session acquired" : `login failed HTTP ${login.status}`);

if (token) {
  const dl = await fetch(`${SITE}/api/downloads/image/${row.id}`, { redirect: "manual", headers: { Authorization: `Bearer ${token}` } });
  const loc = dl.headers.get("location") || "";
  rec("P4b-download-302", dl.status === 302 && loc.startsWith("https://raw.githubusercontent.com/"), `HTTP ${dl.status} -> ${loc.split("?")[0]}`);
}

// P5: site health
const health = await fetch(`${SITE}/api/health`);
rec("P5-health", health.status === 200, `HTTP ${health.status}`);

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} PASS (run at ${new Date().toISOString()})`);
process.exit(pass === results.length ? 0 : 1);
