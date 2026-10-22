// System-prompt shape tests: the compact (local-model) prompt must keep the
// full contract (JSON format + every action + skill essentials) at ~half size.
// Run: cd artifacts/api-server && ../../scripts/node_modules/.bin/tsx ../../tests/prompt-tests.cts
import { buildSystemPrompt } from "../artifacts/api-server/src/lib/ai-brain";

let pass = 0, fail = 0;
const t = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}`); };

const catalog = [{ name: "wave_hello", description: "Say hi from a self-written skill" }];
const full = buildSystemPrompt(catalog, false);
const compact = buildSystemPrompt(catalog, true);
console.log(`prompt chars: full=${full.length} compact=${compact.length} ratio=${(compact.length / full.length).toFixed(2)}`);

t("compact is at most 65% of full", compact.length <= full.length * 0.65);
t("compact still substantial (>1200 chars)", compact.length > 1200);

const ACTIONS = ["say", "goto", "come", "follow", "mine", "chop", "killMobs", "attack", "guard", "wander", "eat", "sleep", "build", "climb", "collect", "deposit", "giveTo", "dropItem", "equip", "pullLever", "wait", "runSkill"];
for (const p of [["full", full], ["compact", compact]] as const) {
  const [label, text] = p;
  t(`${label}: contains JSON contract`, text.includes('"steps"') && text.includes('"done"') && text.includes('"reasoning"'));
  t(`${label}: all 22 actions documented`, ACTIONS.every((a) => text.includes(a)));
  t(`${label}: skill catalog included`, text.includes("wave_hello"));
  t(`${label}: skill-writing essentials`, text.includes("newSkill") && text.includes("checkpoint") && text.includes("dig(") );
}
t("compact: resource/tree enums present", compact.includes("diamond") && compact.includes("oak"));
t("default (no flag) is the full prompt", buildSystemPrompt(catalog) === full);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
