// Shared constants + helpers for the Collections v2 API.
// Mirrors the client contract in src/collections.jsx — keep PRESETS and the
// limits in sync across both.

// Preset names allowed on a directly-shareable (unlisted) collection. A
// collection carrying only a preset name (or no name) and NO description needs
// no moderation; any custom free text must go through public review instead.
export const COLLECTION_PRESETS = [
  "My Favorites",
  "Recommended",
  "To Play",
  "Needle",
  "Avoidance",
  "Gimmick",
  "Beginner Friendly",
  "Hall of Fame",
];

export const LIMITS = {
  TOP_LEVEL: 20,   // max top-level collections per user
  SUBS: 5,         // max sub-collections per folder
  ITEMS: 1000,     // max games per list
  NAME: 60,        // max name length
  DESC: 300,       // max description length
};

// Unguessable random share token (128-bit hex). Not enumerable.
export function genShareToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// A name is safe for direct (unlisted) sharing when it is empty or an exact
// preset. `description` must be empty for unlisted sharing.
export function isShareableName(name) {
  if (name === null || name === undefined || name === "") return true;
  return COLLECTION_PRESETS.includes(name);
}

export function isShareableUnlisted(name, description) {
  return isShareableName(name) && !description;
}

// Load a collection row owned by userId, or null.
export async function getOwnedCollection(env, userId, id) {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;
  return env.DB.prepare(
    `SELECT * FROM collections WHERE id = ? AND user_id = ?`
  ).bind(numId, userId).first();
}

// Count games in a collection.
export async function itemCount(env, collectionId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?`
  ).bind(collectionId).first();
  return row ? row.n : 0;
}

// Count direct sub-collections of a collection.
export async function childCount(env, collectionId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM collections WHERE parent_id = ?`
  ).bind(collectionId).first();
  return row ? row.n : 0;
}

// Normalize + validate an optional text field; returns {ok, value, error}.
export function cleanText(value, max, label) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") return { ok: false, error: `Invalid ${label}.` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: `${label} is too long (max ${max}).` };
  return { ok: true, value: trimmed };
}
