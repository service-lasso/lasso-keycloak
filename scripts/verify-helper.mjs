import { strict as assert } from "node:assert";
import { ensureDatabase } from "./lasso-keycloak.mjs";

const baseEnv = {
  POSTGRE_HOST: "127.0.0.1",
  POSTGRE_PORT: "5432",
  POSTGRE_AUTH_USERNAME: "keycloak_owner",
  POSTGRE_AUTH_PASSWORD: "super-secret-password",
  PGPASSWORD: "super-secret-password",
  PGDATABASE: "keycloak_app",
};

function createPsqlDouble({ databaseExists = false, unavailable = false, authFailure = false } = {}) {
  const calls = [];
  return {
    calls,
    psql(args) {
      calls.push(args);
      const sql = args.at(-1);

      if (unavailable || authFailure) {
        return {
          status: 2,
          stdout: "",
          stderr: authFailure
            ? 'FATAL: password authentication failed for user "keycloak_owner" using super-secret-password'
            : "could not connect to server: Connection refused",
        };
      }

      if (sql === "SELECT 1") {
        return { status: 0, stdout: "1\n", stderr: "" };
      }

      if (String(sql).includes("CREATE DATABASE")) {
        databaseExists = true;
        return { status: 0, stdout: "", stderr: "" };
      }

      if (String(sql).includes("FROM pg_database")) {
        return { status: 0, stdout: databaseExists ? "1\n" : "", stderr: "" };
      }

      return { status: 1, stdout: "", stderr: `unexpected psql call: ${args.join(" ")}` };
    },
  };
}

async function expectRejectsWithoutSecret(action, expectedText) {
  let thrown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error, "Expected ensureDatabase to fail.");
  assert.match(thrown.message, expectedText);
  assert(!thrown.message.includes(baseEnv.POSTGRE_AUTH_PASSWORD), "Failure message must redact database secrets.");
}

{
  const fake = createPsqlDouble({ databaseExists: false });
  await ensureDatabase({ env: baseEnv, psql: fake.psql, sleepFn: async () => {}, timeoutMs: 1_000 });
  assert(fake.calls.some((args) => args.includes("database_name=keycloak_app")), "Database name should come from PGDATABASE.");
  assert(fake.calls.some((args) => String(args.at(-1)).includes("CREATE DATABASE")), "Missing database flow should attempt creation.");
}

{
  const fake = createPsqlDouble({ databaseExists: true });
  await ensureDatabase({ env: baseEnv, psql: fake.psql, sleepFn: async () => {}, timeoutMs: 1_000 });
  assert(fake.calls.some((args) => String(args.at(-1)).includes("FROM pg_database")), "Existing database flow should verify presence.");
}

await expectRejectsWithoutSecret(
  async () => ensureDatabase({
    env: baseEnv,
    psql: createPsqlDouble({ unavailable: true }).psql,
    sleepFn: async () => {},
    timeoutMs: 1,
  }),
  /Timed out waiting for PostgreSQL readiness/,
);

await expectRejectsWithoutSecret(
  async () => ensureDatabase({
    env: baseEnv,
    psql: createPsqlDouble({ authFailure: true }).psql,
    sleepFn: async () => {},
    timeoutMs: 1_000,
  }),
  /PostgreSQL authentication failed/,
);

console.log("lasso-keycloak setup helper verification passed.");
