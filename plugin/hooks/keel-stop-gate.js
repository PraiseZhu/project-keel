// KEEL Stop hook for Claude Code and Codex, run by macOS JavaScript for Automation so no Node is needed:
//   /usr/bin/osascript -l JavaScript keel-stop-gate.js --harness claude-code|codex --index <runs/active.json>
// Blocks the lead from ending while a run in its cwd is still active. Read-only. Fail-open.
// The returned string is the only stdout and is always one JSON object.
// The plugin's Node worker installs it (src/node/hooks-install.ts); tests load the pure functions below.

var MARK = "keel-stop-gate";
var ALLOW_STATUS = ["done", "stopped", "stalled", "paused", "waiting_human"];

function parseArgs(argv) {
  var out = { harness: "", index: "" };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    var next = argv[i + 1];
    if (a === "--harness" && next) { out.harness = next; i++; }
    else if (a === "--index" && next) { out.index = next; i++; }
  }
  return out;
}

function norm(p) {
  if (typeof p !== "string" || !p) return "";
  var abs = p.charAt(0) === "/";
  var parts = [];
  p.split("/").forEach(function (seg) {
    if (!seg || seg === ".") return;
    if (seg === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (seg !== ".." || !abs) parts.push(seg);
  });
  return (abs ? "/" : "") + parts.join("/") || (abs ? "/" : "");
}

function under(cwd, dir) {
  var c = norm(cwd);
  var w = norm(dir);
  return Boolean(c && w && (c === w || c.indexOf(w + "/") === 0));
}

function matchWorkdir(cwd, index) {
  var c = norm(cwd);
  if (!c || !index || typeof index !== "object") return null;
  var best = null;
  var bestLen = -1;
  Object.keys(index).forEach(function (workdir) {
    var w = norm(workdir);
    if (!w || !under(c, w) || w.length <= bestLen) return;
    var row = index[workdir];
    best = row && typeof row === "object" ? Object.assign({ workdir: w }, row) : null;
    bestLen = w.length;
  });
  return best;
}

function evaluate(event, index) {
  var active = event && event.stop_hook_active;
  if (active === true || active === "true") return { action: "allow", why: "stop_hook_active" };
  if (!index || typeof index !== "object" || Array.isArray(index)) return { action: "allow", why: "no_index" };
  var cwd = event && typeof event.cwd === "string" ? event.cwd : "";
  // Sessions inside a run's worktree are KEEL workers; only the lead is gated.
  var inWorktree = Object.keys(index).some(function (k) {
    var row = index[k];
    return row && typeof row === "object" && under(cwd, row.worktree);
  });
  if (inWorktree) return { action: "allow", why: "worker_worktree" };
  var hit = matchWorkdir(cwd, index);
  if (!hit) return { action: "allow", why: "cwd_mismatch" };
  if (ALLOW_STATUS.indexOf(String(hit.status == null ? "" : hit.status)) >= 0) return { action: "allow", why: "terminal_status" };
  return { action: "block", run_id: String(hit.run_id == null ? "" : hit.run_id), current_node: String(hit.current_node || "—") };
}

function formatOutput(harness, result) {
  if (result.action !== "block") return {};
  var reason = "KEEL：run " + result.run_id + " 未完成（" + result.current_node + "）。如果你是 KEEL 派出的 worker（任务说明里有 dispatch_key），交完报告直接结束，不要调用 keel_*；如果你是主控，先调用 keel_status 取下一步，照 next 执行。";
  if (harness === "codex") return { decision: "block", reason: reason, continue: true };
  return { decision: "block", reason: reason };
}

/** indexText is null when the index file could not be read. */
function decide(opts, stdinText, indexText) {
  var event;
  try { event = stdinText && stdinText.trim() ? JSON.parse(stdinText) : {}; }
  catch (e) { return formatOutput(opts.harness, { action: "allow", why: "bad_event" }); }
  var index = null;
  try { index = indexText == null ? null : JSON.parse(indexText); }
  catch (e) { index = null; }
  return formatOutput(opts.harness, evaluate(event, index));
}

function run(argv) {
  try {
    ObjC.import("Foundation");
    var opts = parseArgs(argv);
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var stdin = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js || "";
    var text = opts.index ? $.NSString.stringWithContentsOfFileEncodingError(opts.index, $.NSUTF8StringEncoding, null) : null;
    var indexText = text && !text.isNil() ? text.js : null;
    return JSON.stringify(decide(opts, stdin, indexText));
  } catch (e) {
    return "{}";
  }
}
