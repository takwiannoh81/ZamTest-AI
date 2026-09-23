#!/usr/bin/env bash
# Runs a backup immediately and prints the result. Run on the server:
#   sudo bash ~/ZamTest-AI/deploy/backup-now.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "Waiting for the orchestrator to be ready..."
for _ in $(seq 1 45); do
  if docker compose exec -T orchestrator node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 2
done

docker compose exec -T orchestrator node -e '
fetch("http://127.0.0.1:4000/api/admin/backup", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.ZAMTEST_ADMIN_TOKEN },
})
  .then(async (r) => {
    const b = await r.json();
    if (!r.ok) {
      console.error("\nBackup FAILED: " + b.error);
      process.exit(1);
    }
    console.log("\nBackup OK");
    console.log("  saved to:   s3://" + (b.location || "").replace(/^s3:\/\//, "").split("/")[0] + "/" + b.key);
    console.log("  next run:   " + b.nextRunAt + " (daily)");
    console.log("  kept for:   " + b.keepDays + " days");
  })
  .catch((e) => {
    console.error("\nBackup FAILED: " + e.message);
    process.exit(1);
  });
'
