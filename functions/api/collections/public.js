// Pages Function API: public library — approved public collections. No auth.
// GET /api/collections/public?page=
import { jsonResponse, errorResponse } from "../_lib/http.js";

const PER_PAGE = 24;

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const page = Math.max(1, parseInt(new URL(request.url).searchParams.get("page") || "1", 10) || 1);
    const offset = (page - 1) * PER_PAGE;

    // Approved, non-empty, non-banned-owner public collections. A folder counts
    // the games inside its sub-collections. Fetch one extra row to compute
    // hasMore without a second COUNT query.
    const { results } = await env.DB.prepare(`
      SELECT c.id, c.name, c.description, c.share_token, c.share_show_owner, c.reviewed_at,
             CASE WHEN c.share_show_owner = 1 THEN u.display_name ELSE NULL END AS owner_name,
             (SELECT COUNT(*) FROM collection_items ci
               WHERE ci.collection_id = c.id
                  OR ci.collection_id IN (SELECT k.id FROM collections k WHERE k.parent_id = c.id
                       AND (k.moderation_status IS NULL OR k.moderation_status = 'approved'))) AS item_count,
             (SELECT COUNT(*) FROM collections k2 WHERE k2.parent_id = c.id) AS child_count
      FROM collections c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.visibility = 'public' AND c.moderation_status = 'approved'
        AND (u.status IS NULL OR u.status != 'banned')
        AND (SELECT COUNT(*) FROM collection_items ci2
              WHERE ci2.collection_id = c.id
                 OR ci2.collection_id IN (SELECT k3.id FROM collections k3 WHERE k3.parent_id = c.id
                      AND (k3.moderation_status IS NULL OR k3.moderation_status = 'approved'))) > 0
      ORDER BY c.reviewed_at DESC, c.id DESC
      LIMIT ? OFFSET ?
    `).bind(PER_PAGE + 1, offset).all();

    const hasMore = results.length > PER_PAGE;
    return jsonResponse({
      success: true,
      collections: results.slice(0, PER_PAGE),
      page,
      hasMore,
    }, 200, { "Cache-Control": "public, max-age=120" });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
