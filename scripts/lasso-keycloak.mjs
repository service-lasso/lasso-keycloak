import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const isWindows = process.platform === "win32";
const command = process.argv[2];

function usage() {
  console.error("Usage: node scripts/lasso-keycloak.mjs <generate-keystore|ensure-database|build>");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function envPath(rootName, relativeExecutable, fallback) {
  const root = process.env[rootName];
  return root ? path.join(root, ...relativeExecutable) : fallback;
}

function javaExecutable() {
  return envPath("JAVA_HOME", ["bin", isWindows ? "java.exe" : "java"], "java");
}

function keytoolExecutable() {
  return envPath("JAVA_HOME", ["bin", isWindows ? "keytool.exe" : "keytool"], "keytool");
}

function psqlExecutable() {
  return envPath("POSTGRE_HOME", ["bin", isWindows ? "psql.exe" : "psql"], "psql");
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function probe(executable, args, options = {}) {
  return spawnSync(executable, args, {
    stdio: "ignore",
    shell: false,
    env: process.env,
    ...options,
  }).status === 0;
}

function output(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    env: process.env,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.\n${result.stderr ?? ""}`,
    );
  }

  return (result.stdout ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgresReady(timeoutMs = 60_000) {
  const startedAt = Date.now();
  const executable = psqlExecutable();
  const args = [
    "-h",
    requireEnv("POSTGRE_HOST"),
    "-p",
    requireEnv("POSTGRE_PORT"),
    "-U",
    requireEnv("POSTGRE_AUTH_USERNAME"),
    "-d",
    "postgres",
    "-tAc",
    "SELECT 1",
  ];

  while (Date.now() - startedAt < timeoutMs) {
    if (probe(executable, args)) {
      return;
    }
    await sleep(500);
  }

  throw new Error("Timed out waiting for PostgreSQL readiness.");
}

async function generateKeystore() {
  const keystorePath = process.env.KC_CONFIG_KEYSTORE ?? path.join(requireEnv("SERVICE_DATA_PATH"), "conf", "server.keystore");
  if (existsSync(keystorePath)) {
    console.log(`[lasso-keycloak] keystore already exists at ${keystorePath}`);
    return;
  }

  await mkdir(path.dirname(keystorePath), { recursive: true });
  run(keytoolExecutable(), [
    "-genkeypair",
    "-storepass",
    requireEnv("KEYCLOAK_ADMIN_PASSWORD"),
    "-storetype",
    "PKCS12",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-dname",
    "CN=server",
    "-alias",
    "server",
    "-ext",
    "SAN:c=DNS:localhost,DNS:typerefinery.localhost,IP:127.0.0.1",
    "-keystore",
    keystorePath,
  ]);
}

async function ensureDatabase() {
  await waitForPostgresReady();
  run(psqlExecutable(), [
    "-h",
    requireEnv("POSTGRE_HOST"),
    "-p",
    requireEnv("POSTGRE_PORT"),
    "-U",
    requireEnv("POSTGRE_AUTH_USERNAME"),
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "SELECT 'CREATE DATABASE keycloak' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\\gexec",
  ]);
  const exists = output(psqlExecutable(), [
    "-h",
    requireEnv("POSTGRE_HOST"),
    "-p",
    requireEnv("POSTGRE_PORT"),
    "-U",
    requireEnv("POSTGRE_AUTH_USERNAME"),
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-tAc",
    "SELECT 1 FROM pg_database WHERE datname = 'keycloak'",
  ]);
  if (exists !== "1") {
    throw new Error("PostgreSQL did not report the keycloak database after setup.");
  }
}

async function buildKeycloak() {
  const serviceBinPath = requireEnv("SERVICE_BIN_PATH");
  const javaArgs = [
    `-Dprogram.name=${isWindows ? "kc.bat" : "kc.sh"}`,
    "-Xms64m",
    "-Xmx512m",
    "-XX:MetaspaceSize=96M",
    "-XX:MaxMetaspaceSize=256m",
    "-Dkc.config.built=true",
    "-Dkc.config.build-and-exit=true",
    "-Dfile.encoding=UTF-8",
    "-Dsun.stdout.encoding=UTF-8",
    "-Dsun.err.encoding=UTF-8",
    "-Dstdout.encoding=UTF-8",
    "-Dstderr.encoding=UTF-8",
    "-XX:+ExitOnOutOfMemoryError",
    "-Djava.security.egd=file:/dev/urandom",
    "-XX:+UseParallelGC",
    "-XX:MinHeapFreeRatio=10",
    "-XX:MaxHeapFreeRatio=20",
    "-XX:GCTimeRatio=4",
    "-XX:AdaptiveSizePolicyWeight=90",
    "-XX:FlightRecorderOptions=stackdepth=512",
    "--add-opens=java.base/java.util=ALL-UNNAMED",
    "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
    "--add-opens=java.base/java.security=ALL-UNNAMED",
    `-Dkc.home.dir=${serviceBinPath}`,
    `-Djboss.server.config.dir=${path.join(serviceBinPath, "conf")}`,
    `-Dkeycloak.theme.dir=${path.join(serviceBinPath, "themes")}`,
    "-Djava.util.logging.manager=org.jboss.logmanager.LogManager",
    "-Dquarkus-log-max-startup-records=10000",
    "-cp",
    path.join(serviceBinPath, "lib", "quarkus-run.jar"),
    "io.quarkus.bootstrap.runner.QuarkusEntryPoint",
    "build",
  ];

  run(javaExecutable(), javaArgs);
}

const commands = {
  "generate-keystore": generateKeystore,
  "ensure-database": ensureDatabase,
  build: buildKeycloak,
};

if (!commands[command]) {
  usage();
  process.exitCode = 2;
} else {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`[lasso-keycloak] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
