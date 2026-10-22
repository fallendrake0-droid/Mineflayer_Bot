// Provider fatal-error hints (OOM, model-not-found local/cloud).
// Run: cd artifacts/api-server && ../../scripts/node_modules/.bin/tsx ../../tests/model404-tests.cts
import { fatalProviderHint } from "../artifacts/api-server/src/lib/ai-client";

let pass = 0, fail = 0;
const t = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}`); };

const cloudCfg = { apiKey: "k", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" };
const localCfg = { apiKey: null, baseUrl: "http://localhost:11434/v1", model: "llama3.2:3b" };

const retiredBody = JSON.stringify([{ error: { code: 404, message: "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements." } }]);
const hint = fatalProviderHint(404, retiredBody, cloudCfg);
t("cloud 404: friendly retired-model hint", !!hint && /was not found at the provider/.test(hint) && /gemini-2\.5-flash/.test(hint));
t("cloud 404: provider's replacement surfaced", !!hint && /gemini-3\.8-flash/.test(hint));

const localHint = fatalProviderHint(404, '{"error":{"message":"model \\"llama3.2:3b\\" not found, try pulling it first"}}', localCfg);
t("local 404: ollama pull hint", !!localHint && /ollama pull llama3\.2:3b/.test(localHint));

const oomHint = fatalProviderHint(500, "llama-server reported out-of-memory: insufficient memory", localCfg);
t("OOM 500: memory hint", !!oomHint && /ran out of memory/.test(oomHint));

t("503 high demand: no hint (retried)", fatalProviderHint(503, "high demand", cloudCfg) === null);
t("401: no hint", fatalProviderHint(401, "invalid api key", cloudCfg) === null);
t("200-ish body on 400: no hint", fatalProviderHint(400, "bad request", cloudCfg) === null);
t("cloud 404 generic body still hinted", !!fatalProviderHint(404, "Not Found", cloudCfg));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
