import { query } from './db.js';

let schemaReady = null;

export async function ensureGroupLibrarySchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS group_categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#1976d2',
        sort_order INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS group_library (
        id SERIAL PRIMARY KEY,
        category_id INT REFERENCES group_categories(id) ON DELETE SET NULL,
        name TEXT NOT NULL DEFAULT '',
        invite_link TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        member_count INT DEFAULT 0,
        added_by TEXT DEFAULT 'admin',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_gl_category ON group_library (category_id)`);
  })();
  return schemaReady;
}

// ─── Categories ───

export async function listCategories() {
  await ensureGroupLibrarySchema();
  const result = await query(`SELECT * FROM group_categories ORDER BY sort_order ASC, name ASC`);
  return result.rows;
}

export async function createCategory(name, color = '#1976d2', sortOrder = 0) {
  await ensureGroupLibrarySchema();
  const slug = name.toLowerCase().replace(/[^a-z0-9\u00C0-\u024F]+/gi, '-').replace(/^-|-$/g, '');
  const result = await query(
    `INSERT INTO group_categories (name, slug, color, sort_order) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name.trim(), slug, color, sortOrder],
  );
  return result.rows[0];
}

export async function updateCategory(id, { name, color, sortOrder } = {}) {
  await ensureGroupLibrarySchema();
  const sets = [];
  const params = [];
  let idx = 1;

  if (name !== undefined) {
    sets.push(`name = $${idx}`);
    params.push(name.trim());
    idx++;
    const slug = name.toLowerCase().replace(/[^a-z0-9\u00C0-\u024F]+/gi, '-').replace(/^-|-$/g, '');
    sets.push(`slug = $${idx}`);
    params.push(slug);
    idx++;
  }
  if (color !== undefined) {
    sets.push(`color = $${idx}`);
    params.push(color);
    idx++;
  }
  if (sortOrder !== undefined) {
    sets.push(`sort_order = $${idx}`);
    params.push(sortOrder);
    idx++;
  }
  if (!sets.length) return null;

  params.push(id);
  const result = await query(
    `UPDATE group_categories SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return result.rows[0] || null;
}

export async function deleteCategory(id) {
  await ensureGroupLibrarySchema();
  await query(`DELETE FROM group_categories WHERE id = $1`, [id]);
}

// ─── Groups ───

export async function listGroups({ categoryId, search, limit = 500, offset = 0 } = {}) {
  await ensureGroupLibrarySchema();
  const conditions = [];
  const params = [];
  let idx = 1;

  if (categoryId) {
    conditions.push(`gl.category_id = $${idx}`);
    params.push(categoryId);
    idx++;
  }
  if (search) {
    conditions.push(`(gl.name ILIKE $${idx} OR gl.invite_link ILIKE $${idx} OR gl.description ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const result = await query(
    `SELECT gl.*, gc.name AS category_name, gc.color AS category_color
     FROM group_library gl
     LEFT JOIN group_categories gc ON gl.category_id = gc.id
     ${where}
     ORDER BY gl.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    params,
  );
  return result.rows;
}

export async function bulkAddGroups(lines, categoryId, addedBy = 'admin') {
  await ensureGroupLibrarySchema();
  const entries = lines
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (!entries.length) return [];

  const inserted = [];
  for (const line of entries) {
    // Each line: invite link, or "name | invite_link", or "name | invite_link | description"
    const parts = line.split('|').map((p) => p.trim());
    let name = '';
    let inviteLink = '';
    let description = '';

    if (parts.length >= 3) {
      [name, inviteLink, description] = parts;
    } else if (parts.length === 2) {
      [name, inviteLink] = parts;
    } else {
      // Single value — treat as invite link
      inviteLink = parts[0];
    }

    // If single value looks like a name (no URL pattern), swap
    if (!inviteLink && name && !/https?:\/\/|zalo\.me/i.test(name)) {
      inviteLink = '';
      // keep as name only
    }

    const result = await query(
      `INSERT INTO group_library (category_id, name, invite_link, description, added_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [categoryId || null, name, inviteLink, description, addedBy],
    );
    if (result.rows[0]) inserted.push(result.rows[0]);
  }
  return inserted;
}

export async function updateGroup(id, { name, inviteLink, description, categoryId, memberCount } = {}) {
  await ensureGroupLibrarySchema();
  const sets = [];
  const params = [];
  let idx = 1;

  if (name !== undefined) { sets.push(`name = $${idx}`); params.push(name); idx++; }
  if (inviteLink !== undefined) { sets.push(`invite_link = $${idx}`); params.push(inviteLink); idx++; }
  if (description !== undefined) { sets.push(`description = $${idx}`); params.push(description); idx++; }
  if (categoryId !== undefined) { sets.push(`category_id = $${idx}`); params.push(categoryId || null); idx++; }
  if (memberCount !== undefined) { sets.push(`member_count = $${idx}`); params.push(memberCount); idx++; }
  if (!sets.length) return null;

  params.push(id);
  const result = await query(
    `UPDATE group_library SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return result.rows[0] || null;
}

export async function deleteGroup(id) {
  await ensureGroupLibrarySchema();
  await query(`DELETE FROM group_library WHERE id = $1`, [id]);
}

export async function deleteGroupsByCategory(categoryId) {
  await ensureGroupLibrarySchema();
  await query(`DELETE FROM group_library WHERE category_id = $1`, [categoryId]);
}

export async function getGroupCount() {
  await ensureGroupLibrarySchema();
  const result = await query(`SELECT COUNT(*)::int AS count FROM group_library`);
  return result.rows[0]?.count || 0;
}

export async function getCategoryCount() {
  await ensureGroupLibrarySchema();
  const result = await query(`SELECT COUNT(*)::int AS count FROM group_categories`);
  return result.rows[0]?.count || 0;
}
