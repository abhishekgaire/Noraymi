#!/usr/bin/env bash
# Local only: the newest sign-in codes the app would have sent, read from the job queue
# (locally nothing reaches a real phone or inbox unless the worker and Mailpit are running).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T postgres psql -U west4 -At -F '  ' -c "
  select to_char(created_at at time zone 'America/New_York', 'HH24:MI:SS'),
         case kind when 'text.send' then 'text to ' || (payload->>'to') else 'email to ' || (payload->>'to') end,
         payload->'data'->>'code'
    from jobs
   where kind in ('text.send', 'email.send') and payload->'data'->>'code' is not null
   order by created_at desc limit 5"
