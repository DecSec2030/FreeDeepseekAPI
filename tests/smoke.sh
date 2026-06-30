#!/bin/bash
set -e
BASE="${1:-http://localhost:9655}"
PASS=0
FAIL=0

check() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$actual" == *"$expected"* ]]; then
        echo "  ✅ $name"
        ((PASS++))
    else
        echo "  ❌ $name (expected '$expected', got '${actual:0:100}')"
        ((FAIL++))
    fi
}

echo "=== Smoke Test: FreeDeepseekAPI ==="
echo ""

# 1. Health check
echo "1. Health check"
R=$(curl -s "$BASE/")
check "status ok" '"status":"ok"' "$R"

# 2. Non-streaming
echo "2. Non-streaming"
R=$(curl -s --max-time 60 "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"say ok. one word"}]}')
CONTENT=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null)
check "non-streaming response" "ok" "$CONTENT"

# 3. Streaming - MUST terminate quickly
echo "3. Streaming termination"
START=$(date +%s%N)
R=$(curl -s --max-time 30 "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"say ok"}],"stream":true}' 2>&1)
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
LAST=$(echo "$R" | tail -1)
check "stream ends with [DONE]" "[DONE]" "$LAST"
if [ "$ELAPSED" -lt 20000 ]; then
    echo "  ✅ Stream completed in ${ELAPSED}ms (under 20s)"
    ((PASS++))
else
    echo "  ❌ Stream took ${ELAPSED}ms (over 20s — possible hang)"
    ((FAIL++))
fi

# 4. Reasoning model streaming
echo "4. Reasoning streaming"
R=$(curl -s --max-time 60 "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash-reasoner","messages":[{"role":"user","content":"2+2=? just number"}],"stream":true}' 2>&1)
LAST=$(echo "$R" | tail -1)
if echo "$R" | grep -q "reasoning_content"; then
    echo "  ✅ Reasoning chunks present"
    ((PASS++))
else
    echo "  ❌ No reasoning_content in stream"
    ((FAIL++))
fi
check "reasoning ends with [DONE]" "[DONE]" "$LAST"

# 5. Metrics
echo "5. Metrics"
R=$(curl -s "$BASE/metrics")
check "metrics endpoint" "freedeepseek_requests_total" "$R"

# 6. Models
echo "6. Models"
R=$(curl -s "$BASE/v1/models")
check "models endpoint" "deepseek-v4-flash" "$R"

# 7. Sessions
echo "7. Sessions"
R=$(curl -s "$BASE/v1/sessions")
check "sessions endpoint" "agents" "$R"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
