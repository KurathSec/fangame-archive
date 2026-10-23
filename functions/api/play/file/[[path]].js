// Game files for the browser player (/play/): objects of the game-files bucket under
// Game/, streamed from this origin. The files host (file.fangame-archive.com) sends no
// CORS headers, and the player's page is cross-origin isolated, so it cannot fetch them
// from there.
//   GET /api/play/file/Game/<name>  (the download URL's path)
// Only for a signed-in account allowed to play in the browser (users.play_access, set in
// the admin app): the play page sends its Clerk token.

const PREFIX = "/api/play/file/";

function objectKey(request) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(PREFIX)) return null;
  let key;
  try {
    key = path.slice(PREFIX.length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  // only the catalog's game files, never a staged submission or anything above
  if (!key.startsWith("Game/") || key.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return key;
}

async function serve(context, head) {
  const user = context.data && context.data.user;
  if (!user || !user.play_access || user.status === "banned") {
    return new Response("Browser play is open to selected accounts only.", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const key = objectKey(context.request);
  if (!key) return new Response("Not found", { status: 404 });
  const object = head ? await context.env.ARCHIVE_FILES.head(key) : await context.env.ARCHIVE_FILES.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  // (per account: no shared cache may keep it)
  headers.set("Cache-Control", "private, max-age=86400");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(head ? null : object.body, { headers });
}

export const onRequestGet = (context) => serve(context, false);
export const onRequestHead = (context) => serve(context, true);
