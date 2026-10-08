import "../instrumentation.js";
import http from "node:http";
import fs from "node:fs";

import { generateNotice, fetchPrompt } from "../notice.js";
import {
  PRODUCTION_LABEL,
  PROMPT_CACHE_TTL_SECONDS,
  LANGFUSE_BASE_URL,
} from "../env.js";
import type { ApplicationCase } from "../domain/types.js";
import { parseArgs, bold, dim, green, blue } from "./_shared.js";

/**
 * The live demo surface.
 *
 * Keep this page on screen, then move the `production` label in the Langfuse UI.
 * Within the prompt cache TTL the version badge flips and the letter rewrites
 * itself — in a process that was started before the new prompt existed and is
 * never restarted. That is the whole argument for prompt management, and it is
 * much more convincing seen than described.
 *
 * `/api/status` is deliberately cheap (a cached prompt read, no model call) so
 * the page can poll it every few seconds without burning tokens. A model call
 * happens only when the version actually changes, or when a human clicks.
 */

const cases = JSON.parse(
  fs.readFileSync("data/cases.json", "utf8"),
) as ApplicationCase[];

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Adverse Action Notice Service</title>
<style>
  :root {
    --bg: #0b0f14; --panel: #131a23; --panel-2: #1a2330; --line: #243041;
    --text: #e7eef7; --muted: #8699ad; --accent: #4da3ff;
    --ok: #3fcf8e; --warn: #f5c451; --bad: #ff6b6b;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 28px; max-width: 1180px; margin-inline: auto;
  }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 22px; }
  .badge {
    display: flex; flex-wrap: wrap; gap: 18px 28px; align-items: center;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 18px 22px; margin-bottom: 18px;
    transition: box-shadow .5s, border-color .5s;
  }
  .badge.flash { border-color: var(--ok); box-shadow: 0 0 0 3px rgba(63,207,142,.18); }
  .kv { display: flex; flex-direction: column; gap: 3px; }
  .kv .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; }
  .kv .v { font-family: var(--mono); font-size: 15px; }
  .ver { font-size: 30px; font-weight: 700; font-family: var(--mono); line-height: 1; color: var(--accent); }
  .pill { font-size: 11px; font-family: var(--mono); padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .pill.prod { color: var(--ok); border-color: rgba(63,207,142,.45); }
  .grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 18px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted);
             margin: 0; padding: 13px 18px; border-bottom: 1px solid var(--line); background: var(--panel-2); }
  .letter { white-space: pre-wrap; font-family: var(--mono); font-size: 13.5px;
            line-height: 1.75; padding: 18px; margin: 0; max-height: 540px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 9px 18px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td.n { font-family: var(--mono); text-align: right; width: 56px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  .muted { color: var(--muted); }
  .detail { color: var(--muted); font-size: 11.5px; display: block; margin-top: 2px; }
  .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
  select, button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 9px 14px; font-size: 13px; font-family: inherit; cursor: pointer;
  }
  button:hover, select:hover { border-color: var(--accent); }
  button[disabled] { opacity: .5; cursor: default; }
  a { color: var(--accent); }
  .foot { color: var(--muted); font-size: 12px; margin-top: 20px; }
  .spin { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--line);
          border-top-color: var(--accent); border-radius: 50%; animation: s .7s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <h1>Adverse Action Notice Service</h1>
  <div class="sub">Northwind Lending, N.A. &middot; ECOA / Regulation B &middot; prompt served from Langfuse</div>

  <div class="badge" id="badge">
    <div class="kv"><span class="k">prompt version</span><span class="ver" id="ver">--</span></div>
    <div class="kv"><span class="k">labels</span><span class="v" id="labels">--</span></div>
    <div class="kv"><span class="k">model</span><span class="v" id="model">--</span></div>
    <div class="kv"><span class="k">compliance</span><span class="v" id="score">--</span></div>
    <div class="kv" style="flex:1 1 280px"><span class="k">commit message</span><span class="v" id="commit" style="font-size:12.5px">--</span></div>
  </div>

  <div class="bar">
    <select id="case"></select>
    <button id="go">Generate notice</button>
    <span class="muted" id="status"></span>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Notice as sent to the applicant</h2>
      <pre class="letter" id="letter">Choose a case and click Generate.</pre>
    </div>
    <div class="card">
      <h2>Compliance checks (every request)</h2>
      <table><tbody id="checks">
        <tr><td class="muted">No run yet.</td></tr>
      </tbody></table>
    </div>
  </div>

  <div class="foot">
    Polling the <code>production</code> label every 3s &middot; prompt cache TTL
    <strong id="ttl">--</strong>s &middot; <a id="lf" href="#" target="_blank">open Langfuse</a>
    <br>Move the <code>production</code> label onto another version in Langfuse and watch this page follow it. No deploy, no restart.
  </div>

<script>
const $ = (id) => document.getElementById(id);
let currentVersion = null;
let busy = false;

const sel = $("case");
for (const c of CASES) {
  const o = document.createElement("option");
  o.value = c.applicationId;
  o.textContent = c.applicationId + " — " + c.applicantName + " (" + c.reasonCodes.length + " reasons)";
  sel.appendChild(o);
}

function renderBadge(s) {
  $("ver").textContent = "v" + s.version;
  $("labels").innerHTML = (s.labels || []).map(
    (l) => '<span class="pill' + (l === "production" ? " prod" : "") + '">' + l + "</span>"
  ).join(" ") || '<span class="muted">none</span>';
  $("model").textContent = s.model || "--";
  $("commit").textContent = s.commitMessage || "(none)";
  $("ttl").textContent = s.cacheTtlSeconds;
  $("lf").href = s.langfuseUrl;
}

function renderResult(r) {
  $("letter").textContent = r.notice;
  const cls = r.complianceScore >= 0.999 ? "ok" : r.complianceScore >= 0.8 ? "warn" : "bad";
  $("score").innerHTML = '<span class="' + cls + '">' + r.complianceScore.toFixed(2) + "</span>";
  $("checks").innerHTML = r.checks.map((c) => {
    const k = c.value >= 0.999 ? "ok" : c.value >= 0.8 ? "warn" : "bad";
    return "<tr><td>" + c.name + '<span class="detail">' + c.comment + "</span></td>" +
           '<td class="n ' + k + '">' + c.value.toFixed(2) + "</td></tr>";
  }).join("");
}

async function generate() {
  if (busy) return;
  busy = true;
  $("go").disabled = true;
  $("status").innerHTML = '<span class="spin"></span> calling the model...';
  try {
    const res = await fetch("/api/generate?case=" + encodeURIComponent(sel.value));
    const r = await res.json();
    if (r.error) { $("status").textContent = r.error; return; }
    renderBadge(r);
    renderResult(r);
    currentVersion = r.version;
    $("status").innerHTML = r.traceUrl
      ? '<a href="' + r.traceUrl + '" target="_blank">view trace</a>'
      : "";
  } catch (e) {
    $("status").textContent = String(e);
  } finally {
    busy = false;
    $("go").disabled = false;
  }
}

async function poll() {
  try {
    const s = await (await fetch("/api/status")).json();
    if (s.error) return;
    renderBadge(s);
    if (currentVersion !== null && s.version !== currentVersion) {
      // The label moved. Flash the badge and re-render with the new prompt.
      $("badge").classList.add("flash");
      $("status").textContent = "production label moved to v" + s.version + " — regenerating";
      setTimeout(() => $("badge").classList.remove("flash"), 2500);
      currentVersion = s.version;
      generate();
    }
  } catch {}
}

$("go").addEventListener("click", generate);
poll();
setInterval(poll, 3000);
</script>
</body>
</html>`;

await (async () => {
  const args = parseArgs();
  const port = Number(args.port ?? process.env.PORT ?? 4321);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        // Inject the case list rather than fetching it separately.
        res.end(PAGE.replace("CASES", JSON.stringify(cases)));
        return;
      }

      // Cheap: reads the in-process prompt cache, never calls a model.
      if (url.pathname === "/api/status") {
        const prompt = await fetchPrompt({ label: PRODUCTION_LABEL });
        const config = (prompt.config ?? {}) as { model?: string };
        json(200, {
          version: prompt.version,
          labels: prompt.labels,
          commitMessage: prompt.commitMessage,
          model: config.model ?? "unknown",
          isFallback: prompt.isFallback,
          cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
          langfuseUrl: LANGFUSE_BASE_URL,
        });
        return;
      }

      if (url.pathname === "/api/generate") {
        const caseId = url.searchParams.get("case");
        const appCase = caseId
          ? cases.find((c) => c.applicationId === caseId)
          : cases[0];
        if (!appCase) return json(404, { error: `Unknown case "${caseId}"` });

        const result = await generateNotice({ appCase, label: PRODUCTION_LABEL });
        const config = (await fetchPrompt({ label: PRODUCTION_LABEL })).config as
          | { model?: string }
          | null;

        json(200, {
          notice: result.notice,
          version: result.promptVersion,
          labels: result.promptLabels,
          commitMessage: result.promptCommitMessage,
          model: config?.model ?? result.model,
          isFallback: result.usedFallback,
          checks: result.checks,
          complianceScore: result.complianceScore,
          cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
          langfuseUrl: LANGFUSE_BASE_URL,
          traceUrl: result.traceId
            ? `${LANGFUSE_BASE_URL}/trace/${result.traceId}`
            : undefined,
        });
        return;
      }

      json(404, { error: "not found" });
    } catch (error) {
      json(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, () => {
    console.log(`\n  ${bold("Adverse Action Notice Service")}`);
    console.log(`  ${green("listening")}  ${blue(`http://localhost:${port}`)}`);
    console.log(
      dim(
        `\n  Serving the prompt labelled "${PRODUCTION_LABEL}" with a ` +
          `${PROMPT_CACHE_TTL_SECONDS}s cache.\n` +
          `  Move the label in Langfuse and watch the page follow it.\n` +
          `  Ctrl-C to stop.\n`,
      ),
    );
  });

  // Flush pending spans on shutdown so the last traces are not lost.
  const stop = async () => {
    const { shutdownTracing } = await import("../instrumentation.js");
    await shutdownTracing().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})();
