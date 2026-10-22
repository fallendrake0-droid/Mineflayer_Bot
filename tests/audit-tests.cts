// Audit-pass unit tests (compass, origin guard, settings, sandbox, skills).
// Run: cd artifacts/api-server && ../../scripts/node_modules/.bin/tsx ../../tests/audit-tests.cts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compassFromYaw, createCheckpointGuard } from "../artifacts/api-server/src/lib/bot-utils";
import { hostnameOf, isBrowserOriginAllowed, isLocalHostname } from "../artifacts/api-server/src/lib/origin-guard";
import { sanitizeSettings } from "../artifacts/api-server/src/lib/bot";
import { SkillLibrary, runSkillInSandbox } from "../artifacts/api-server/src/lib/ai-skills";

let pass = 0, fail = 0;
const t = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}`); };

const D = Math.PI / 180;
t("compass 0 -> E", compassFromYaw(0) === "E");
t("compass 90 -> N", compassFromYaw(90 * D) === "N");
t("compass 180 -> W", compassFromYaw(180 * D) === "W");
t("compass 270 -> S", compassFromYaw(270 * D) === "S");
t("compass 45 -> NE", compassFromYaw(45 * D) === "NE");
t("compass 135 -> NW", compassFromYaw(135 * D) === "NW");
t("compass 225 -> SW", compassFromYaw(225 * D) === "SW");
t("compass 315 -> SE", compassFromYaw(315 * D) === "SE");
t("compass -90 -> S", compassFromYaw(-90 * D) === "S");
t("compass 720 -> E", compassFromYaw(720 * D) === "E");

t("hostnameOf URL", hostnameOf("https://Example.COM:8443/x") === "example.com");
t("hostnameOf host:port", hostnameOf("localhost:5173") === "localhost");
t("hostnameOf [::1]:p", hostnameOf("[::1]:5000") === "::1");
t("isLocalHostname", isLocalHostname("localhost") && isLocalHostname("127.0.0.1") && !isLocalHostname("evil.com"));

const allow = (h: any) => isBrowserOriginAllowed(h);
t("origin: none (curl) allowed", allow({ host: "localhost:5000" }) === true);
t("origin: localhost dashboard", allow({ origin: "http://localhost:5173", host: "127.0.0.1:5000" }) === true);
t("origin: evil.com blocked", allow({ origin: "https://evil.example", host: "localhost:5000" }) === false);
t("origin: evil.com + cross-site blocked", allow({ origin: "https://evil.example", host: "localhost:5000", "sec-fetch-site": "cross-site" }) === false);
t("origin: preview via xfwd-host", allow({ origin: "https://5173-abc.e2b.app", host: "127.0.0.1:5000", "x-forwarded-host": "5173-abc.e2b.app" }) === true);
t("origin: preview via sec-fetch-site", allow({ origin: "https://5173-abc.e2b.app", host: "127.0.0.1:5000", "sec-fetch-site": "same-origin" }) === true);
t("origin: same host (LAN direct)", allow({ origin: "http://192.168.1.20:5173", host: "192.168.1.20:5000" }) === true);
t("origin: 'null' blocked", allow({ origin: "null", host: "localhost:5000" }) === false);
t("origin: garbage blocked", allow({ origin: "ht!tp://[bad", host: "localhost:5000" }) === false);
t("origin: subdomain mismatch blocked", allow({ origin: "https://evil.e2b.app", host: "5173-abc.e2b.app" }) === false);

{
  const s = sanitizeSettings({ autoEat: "yes", autoEatThreshold: "lots", maxReconnectAttempts: -5, chatCommandOwners: "Bob", viewerEnabled: false, extra: 1 } as any);
  t("settings: wrong types -> defaults", s.autoEat === true && s.autoEatThreshold === 14 && s.maxReconnectAttempts === 0 && Array.isArray(s.chatCommandOwners) && s.chatCommandOwners.length === 0);
  t("settings: valid values kept", s.viewerEnabled === false);
  const s2 = sanitizeSettings({ autoEatThreshold: 99, chatCommandOwners: [" Alice ", "Alice", "", "bob"] } as any);
  t("settings: clamp + owner cleanup", s2.autoEatThreshold === 20 && JSON.stringify(s2.chatCommandOwners) === '["Alice","bob"]');
  const s3 = sanitizeSettings(null);
  t("settings: null -> defaults", s3.autoReconnect === true && s3.aiEnabled === true && s3.aiChatEnabled === false);
  const s4 = sanitizeSettings([1, 2] as any);
  t("settings: array -> defaults", s4.antiAfk === false && s4.viewerFirstPerson === true);
}

{
  const g = createCheckpointGuard(3, 50);
  let threw = false;
  try { g(); g(); g(); g(); } catch { threw = true; }
  t("checkpoint guard trips over limit", threw);
  const g2 = createCheckpointGuard();
  let ok = true;
  try { for (let i = 0; i < 20_000; i++) g2(); } catch { ok = false; }
  let threw2 = false;
  try { g2(); } catch { threw2 = true; }
  t("checkpoint guard default 20000/2s", ok && threw2);
}

async function main() {
  const circ = await runSkillInSandbox("const o = { a: 1 }; o.self = o; return o;", {}, { timeoutMs: 5000, onTimeout: () => {}, onLog: () => {} });
  t("sandbox: circular return -> ok", circ.ok === true && typeof circ.result === "string");
  const syntax = await runSkillInSandbox("this is not js {{", {}, { timeoutMs: 5000, onTimeout: () => {}, onLog: () => {} });
  t("sandbox: syntax error -> error outcome", syntax.ok === false);
  const blocked = await runSkillInSandbox("return process.pid;", {}, { timeoutMs: 5000, onTimeout: () => {}, onLog: () => {} });
  t("sandbox: process blocked", blocked.ok === false && /process/.test(blocked.error ?? ""));
  const good = await runSkillInSandbox("return 'hi';", {}, { timeoutMs: 5000, onTimeout: () => {}, onLog: () => {} });
  t("sandbox: simple return", good.ok === true && good.result === "hi");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skills-"));
  const file = path.join(dir, "skills.json");
  fs.writeFileSync(file, "not json {{{");
  const lib = new SkillLibrary(file);
  const backupExists = fs.readdirSync(dir).some((f) => /\.corrupt-\d+$/.test(f));
  t("skilllib: corrupt file backed up, empty start", lib.list().length === 0 && backupExists);
  lib.upsert("wave_hi", "say hi", "await api.say('hi');");
  const lib2 = new SkillLibrary(file);
  t("skilllib: roundtrip persists", lib2.list().length === 1 && lib2.get("wave_hi")?.description === "say hi");
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("TEST ERROR", e); process.exit(2); });
