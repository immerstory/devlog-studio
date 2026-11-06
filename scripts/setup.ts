/**
 * One-time setup: generates credentials in .env and docker/garage.toml, starts Postgres and Garage,
 * and creates the Garage layout, bucket and access key. Safe to run again; existing values are kept.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
const GARAGE_TOML = path.join(ROOT, "docker", "garage.toml");
const hex = (bytes: number) => crypto.randomBytes(bytes).toString("hex");

function readEnv(): Map<string, string> {
  const env = new Map<string, string>();
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env.set(m[1], m[2]);
  }
  return env;
}

function writeEnv(env: Map<string, string>) {
  fs.writeFileSync(ENV_FILE, [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

const env = readEnv();
const ensure = (key: string, value: () => string) => {
  if (!env.get(key)) env.set(key, value());
};
ensure("POSTGRES_PASSWORD", () => hex(16));
ensure("POSTGRES_PORT", () => "5544");
ensure("S3_PORT", () => "3940");
ensure("S3_BUCKET", () => "devlog");
ensure("S3_ACCESS_KEY", () => `GK${hex(12)}`);
ensure("S3_SECRET_KEY", () => hex(32));
env.set("DATABASE_URL", `postgres://devlog:${env.get("POSTGRES_PASSWORD")}@127.0.0.1:${env.get("POSTGRES_PORT")}/devlog`);
env.set("S3_ENDPOINT", `http://127.0.0.1:${env.get("S3_PORT")}`);
writeEnv(env);
console.log("✓ .env");

if (!fs.existsSync(GARAGE_TOML)) {
  fs.mkdirSync(path.dirname(GARAGE_TOML), { recursive: true });
  fs.writeFileSync(
    GARAGE_TOML,
    `metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "${hex(32)}"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "${hex(32)}"
`,
  );
  console.log("✓ docker/garage.toml");
}

const compose = (args: string[]) => execFileSync("docker", ["compose", ...args], { cwd: ROOT, encoding: "utf8" });
compose(["up", "-d"]);
console.log("✓ containers started");

const garage = (args: string[]) => spawnSync("docker", ["compose", "exec", "-T", "garage", "/garage", "-c", "/etc/garage.toml", ...args], { cwd: ROOT, encoding: "utf8" });

let status = "";
for (let i = 0; i < 30; i++) {
  const r = garage(["status"]);
  if (r.status === 0) {
    status = r.stdout;
    break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
if (!status) throw new Error("Garage did not start; check `docker compose logs garage`.");

if (status.includes("NO ROLE ASSIGNED")) {
  const nodeId = garage(["node", "id", "-q"]).stdout.trim().split("@")[0];
  garage(["layout", "assign", "-z", "dc1", "-c", "50G", nodeId]);
  const apply = garage(["layout", "apply", "--version", "1"]);
  if (apply.status !== 0) throw new Error(apply.stderr);
  console.log("✓ garage layout");
}

const bucket = env.get("S3_BUCKET")!;
if (garage(["bucket", "info", bucket]).status !== 0) {
  const r = garage(["bucket", "create", bucket]);
  if (r.status !== 0) throw new Error(r.stderr);
}
if (garage(["key", "info", env.get("S3_ACCESS_KEY")!]).status !== 0) {
  const r = garage(["key", "import", "--yes", "-n", "devlog-studio", env.get("S3_ACCESS_KEY")!, env.get("S3_SECRET_KEY")!]);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}
const allow = garage(["bucket", "allow", "--read", "--write", "--owner", bucket, "--key", env.get("S3_ACCESS_KEY")!]);
if (allow.status !== 0) throw new Error(allow.stderr);
console.log(`✓ garage bucket "${bucket}" and key`);
console.log("Setup complete. Run `npm start`.");
