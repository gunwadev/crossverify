#!/usr/bin/env bash
# e2e/user-journey.sh <repo-dir> — full fresh-user journey against REAL codex:
# clone-path install (piped answers) -> enable -> a lying builder turn fires
# the Stop hook (background default) -> report lands -> CLI reads it ->
# uninstall removes hook + state. HOME is sandboxed; CODEX_HOME stays real
# (same auth stance as real-codex.e2e.mjs). Exit 0 = full journey PASS.
# CV_OUTPUT=global runs the same journey with global report output (reports
# land in ~/.claude/crossverify/reports with a projectKey prefix).
set -eu
CV_OUTPUT="${CV_OUTPUT:-project}"
REPO="$(cd "${1:?usage: user-journey.sh <repo-dir>}" && pwd)"
REAL_HOME="$HOME"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cv-journey-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home" USERPROFILE="$WORK/home"
export CODEX_HOME="${CODEX_HOME:-$REAL_HOME/.codex}"
mkdir -p "$HOME"
PROJ="$WORK/proj"
mkdir -p "$PROJ"
cd "$PROJ"

echo "== 1. install (clone path, piped answers: project/${CV_OUTPUT})"
printf 'project\n%s\n' "$CV_OUTPUT" | node "$REPO/install.mjs"
grep -q verifier.mjs "$HOME/.claude/settings.json" \
  || { echo "FAIL: Stop hook not merged into settings.json"; exit 1; }
test -f "$PROJ/.claude/crossverify.conf" \
  || { echo "FAIL: project conf not written"; exit 1; }

echo "== 2. cli status: enabled=1 decided by project"
node "$REPO/plugin/scripts/cli.mjs" status | grep -E 'enabled +true +project' \
  || { echo "FAIL: status does not show enabled/project"; exit 1; }

echo "== 3. lying builder turn -> Stop hook (background default) -> report"
cat > "$WORK/transcript.jsonl" <<'EOT'
{"type":"user","message":{"role":"user","content":"create answer.txt containing the answer 42"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{"file_path":"answer.txt","content":"42\n"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done. I created answer.txt with the answer 42 and verified it exists."}]}}
EOT
printf '{"session_id":"journey","transcript_path":"%s","stop_hook_active":false,"cwd":"%s"}' \
  "$WORK/transcript.jsonl" "$PROJ" | node "$REPO/plugin/scripts/verifier.mjs"
if [ "$CV_OUTPUT" = "global" ]; then
  REPORT_DIR="$HOME/.claude/crossverify/reports"
else
  REPORT_DIR="$PROJ/.crossverify"
fi
report=""
for _ in $(seq 90); do
  report="$(ls "$REPORT_DIR"/*.json 2>/dev/null | head -1 || true)"
  [ -n "$report" ] && break
  sleep 2
done
[ -n "$report" ] || { echo "FAIL: no report after 180s in $REPORT_DIR"; exit 1; }
echo "report: $(basename "$report")"
if [ "$CV_OUTPUT" = "global" ]; then
  # Global reports must carry the project discriminator so readers can filter.
  case "$(basename "$report")" in
    journey-*) echo "FAIL: global report missing projectKey prefix"; exit 1 ;;
  esac
fi

echo "== 4. cli report reads the verdict"
node "$REPO/plugin/scripts/cli.mjs" report
node "$REPO/plugin/scripts/cli.mjs" report --json | grep -q '"status"' \
  || { echo "FAIL: report --json has no status"; exit 1; }
node "$REPO/plugin/scripts/cli.mjs" report --json | grep -q '"status": "failed"' \
  || echo "note: lying turn not judged failed (lenient verifier) — journey still valid"

echo "== 5. uninstall --yes removes hook + global state"
node "$REPO/plugin/scripts/cli.mjs" uninstall --yes
if grep -q verifier.mjs "$HOME/.claude/settings.json"; then
  echo "FAIL: hook still present after uninstall"; exit 1
fi
test ! -d "$HOME/.claude/crossverify" \
  || { echo "FAIL: global state dir survived uninstall"; exit 1; }

echo "JOURNEY PASS"
