import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const command = process.argv[2];

function usage() {
  console.error("Usage: node scripts/lasso-keycloak.mjs <generate-keystore|ensure-database|build>");
}

function requireEnv(name, env = process.env) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function envPath(rootName, relativeExecutable, fallback, env = process.env) {
  const root = env[rootName];
  return root ? path.join(root, ...relativeExecutable) : fallback;
}

function javaExecutable(env = process.env) {
  return envPath("JAVA_HOME", ["bin", isWindows ? "java.exe" : "java"], "java", env);
}

function keytoolExecutable(env = process.env) {
  return envPath("JAVA_HOME", ["bin", isWindows ? "keytool.exe" : "keytool"], "keytool", env);
}

function psqlExecutable(env = process.env) {
  return envPath("POSTGRE_HOME", ["bin", isWindows ? "psql.exe" : "psql"], "psql", env);
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

function redact(text, env = process.env) {
  let sanitized = String(text ?? "");
  for (const name of ["PGPASSWORD", "POSTGRE_AUTH_PASSWORD", "KC_DB_PASSWORD", "KEYCLOAK_ADMIN_PASSWORD"]) {
    const value = env[name];
    if (value) {
      sanitized = sanitized.split(value).join("<redacted>");
    }
  }
  return sanitized.trim();
}

function isAuthenticationFailure(stderr) {
  return /authentication failed|password authentication failed|no pg_hba\.conf entry/i.test(stderr);
}

function invokePsql(args, { env = process.env } = {}) {
  return spawnSync(psqlExecutable(env), args, {
    encoding: "utf8",
    shell: false,
    env,
  });
}

function assertPsql(result, args, env = process.env) {
  if (result.status !== 0) {
    throw new Error(
      `${psqlExecutable(env)} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.\n${redact(result.stderr, env)}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgresReady({ timeoutMs = 60_000, env = process.env, psql = invokePsql, sleepFn = sleep } = {}) {
  const startedAt = Date.now();
  const args = [
    "-h",
    requireEnv("POSTGRE_HOST", env),
    "-p",
    requireEnv("POSTGRE_PORT", env),
    "-U",
    requireEnv("POSTGRE_AUTH_USERNAME", env),
    "-d",
    "postgres",
    "-tAc",
    "SELECT 1",
  ];

  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    const result = psql(args, { env });
    if (result.status === 0) {
      return;
    }
    lastError = redact(result.stderr, env);
    if (isAuthenticationFailure(lastError)) {
      throw new Error(
        `PostgreSQL authentication failed for user ${requireEnv("POSTGRE_AUTH_USERNAME", env)} at ${requireEnv("POSTGRE_HOST", env)}:${requireEnv("POSTGRE_PORT", env)}. ${lastError}`,
      );
    }
    await sleepFn(500);
  }

  throw new Error(
    `Timed out waiting for PostgreSQL readiness at ${requireEnv("POSTGRE_HOST", env)}:${requireEnv("POSTGRE_PORT", env)} as user ${requireEnv("POSTGRE_AUTH_USERNAME", env)}.${lastError ? ` Last psql error: ${lastError}` : ""}`,
  );
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

export async function ensureDatabase({ env = process.env, psql = invokePsql, timeoutMs = 60_000, sleepFn = sleep } = {}) {
  const host = requireEnv("POSTGRE_HOST", env);
  const port = requireEnv("POSTGRE_PORT", env);
  const user = requireEnv("POSTGRE_AUTH_USERNAME", env);
  const database = requireEnv("PGDATABASE", env);

  console.log(`[lasso-keycloak] ensuring PostgreSQL database "${database}" exists at ${host}:${port} as ${user}`);
  await waitForPostgresReady({ timeoutMs, env, psql, sleepFn });
  assertPsql(psql([
    "-h",
    host,
    "-p",
    port,
    "-U",
    user,
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    `database_name=${database}`,
    "-c",
    "SELECT 'CREATE DATABASE ' || quote_ident(:'database_name') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database_name')\\gexec",
  ], { env }), [
    "-h",
    host,
    "-p",
    port,
    "-U",
    user,
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    `database_name=${database}`,
    "-c",
    "SELECT 'CREATE DATABASE ' || quote_ident(:'database_name') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database_name')\\gexec",
  ], env);
  const exists = assertPsql(psql([
    "-h",
    host,
    "-p",
    port,
    "-U",
    user,
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    `database_name=${database}`,
    "-tAc",
    "SELECT 1 FROM pg_database WHERE datname = :'database_name'",
  ], { env }), [
    "-h",
    host,
    "-p",
    port,
    "-U",
    user,
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    `database_name=${database}`,
    "-tAc",
    "SELECT 1 FROM pg_database WHERE datname = :'database_name'",
  ], env);
  if (exists !== "1") {
    throw new Error(`PostgreSQL did not report the ${database} database after setup.`);
  }
  console.log(`[lasso-keycloak] PostgreSQL database "${database}" is ready`);
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

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly && !commands[command]) {
  usage();
  process.exitCode = 2;
} else if (invokedDirectly) {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`[lasso-keycloak] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
