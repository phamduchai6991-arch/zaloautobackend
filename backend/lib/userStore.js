import { query } from './db.js';

function rowToUser(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    lastSeenAt: row.last_seen_at?.toISOString?.() || row.last_seen_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

export async function upsertUser(user) {
  if (!user?.userId) return null;

  const now = new Date().toISOString();
  const result = await query(
    `INSERT INTO users (user_id, email, name, picture, created_at, last_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       email = COALESCE(NULLIF($2, ''), users.email),
       name = COALESCE(NULLIF($3, ''), users.name),
       picture = COALESCE(NULLIF($4, ''), users.picture),
       last_seen_at = $5,
       updated_at = $5
     RETURNING *`,
    [user.userId, user.email || '', user.name || '', user.picture || '', now],
  );

  return rowToUser(result.rows[0]);
}

export async function getAllUsers() {
  const result = await query('SELECT * FROM users ORDER BY created_at DESC');
  return result.rows.map(rowToUser);
}