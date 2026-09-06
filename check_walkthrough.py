from pathlib import Path
import sys
text = Path("docs/INSTANCE-CLI.md").read_text().split("## Fresh-session recovery walkthrough", 1)[1]
required = ["task context", "CONTEXT_TOO_LARGE", "task contract", "task checkpoint", "task save", "equivalenceEvidence", "task continue", "acceptanceEvidence", "task transition"]
missing = [item for item in required if item not in text]
print("FAIL: missing recovery steps: " + ", ".join(missing) if missing else "PASS: recovery steps present")
sys.exit(bool(missing))
