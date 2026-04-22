import { query } from '../../backend/lib/db.js';

const rows = await query(`
  select
    owner_user_id,
    account_zalo_id,
    conversation_id,
    is_group,
    max(ts_ms) as last_ts_ms,
    count(*)::int as cnt
  from zalo_message_history
  where is_group = true
  group by owner_user_id, account_zalo_id, conversation_id, is_group
  order by last_ts_ms desc
  limit 10
`);

console.log(JSON.stringify(rows.rows, null, 2));
