/**
 * Composing a patched `data:` worker URL from a page's `data:` URL.
 *
 * Two places build one: the worker relay (`worker-relay.ts`), when it starts
 * a held `data:` worker's code with the payload, and the nested-worker
 * wrapper (`WORKER_WRAPPER` in `worker-patching.ts`), when a held `data:`
 * worker creates a nested `data:` worker. Both run in worker scope, so the
 * logic lives once, here, as ES5 source that each of them interpolates.
 *
 * Keeping the worker on `data:` matters because a page's CSP can allow
 * `data:` workers and refuse `blob:` ones; a `data:` replacement loads exactly
 * when the page's own URL would.
 */

/**
 * Longest composed URL, measured after URL parsing, that the composer returns.
 * Chrome refuses worker URLs longer than about 2 MiB once parsed (a raw
 * non-ASCII character becomes `%XX` per UTF-8 byte), and Chrome is the
 * binding engine, so one limit applies on every engine.
 */
export const MAX_DATA_URL = 2_000_000;

/**
 * ES5 source defining `function __gsComposeData(url, payload)`, which returns
 * a `data:` URL that runs `payload`, a newline, and then the page's source, or
 * `null` when it can't (no comma, invalid base64, or a parsed URL longer than
 * {@link MAX_DATA_URL}). The caller then starts the worker from the page's own
 * URL, unpatched.
 *
 * - The payload is percent-encoded under `application/javascript`. Classic
 *   worker scripts are always decoded as UTF-8, so the page's MIME type and
 *   charset don't need to be kept.
 * - A non-base64 body is appended verbatim, so the browser percent-decodes it
 *   exactly as it would have decoded the page's URL (lone `%`, raw characters,
 *   a trailing `#fragment`).
 * - A base64 body is decoded the way the fetch `data:` URL processor does
 *   (fragment dropped, `%XX` decoded, forgiving base64 via `atob`) and its
 *   bytes are re-emitted as themselves, except bytes below 0x21, `#`, `%` and
 *   bytes from 0x7F up, which become `%XX`. Bytes are collected in chunks
 *   joined once, so the cost stays linear in every engine.
 *
 * It uses only `URL`, `atob`, `encodeURIComponent`, and language built-ins,
 * and contains none of the `WORKER_WRAPPER` placeholder names, because it is
 * interpolated into that wrapper ahead of their code positions.
 */
export const COMPOSE_DATA_SOURCE = `
function __gsComposeData(url, payload) {
  var comma = url.indexOf(",");
  if (comma === -1) return null;
  var meta = url.substring(5, comma);
  var body = url.substring(comma + 1);
  var result = "data:application/javascript," + encodeURIComponent(payload + "\\n");
  if (!/;\\s*base64\\s*$/i.test(meta)) {
    result += body;
  } else {
    var hash = body.indexOf("#");
    if (hash !== -1) body = body.substring(0, hash);
    body = body.replace(/%([0-9A-Fa-f]{2})/g, function (m, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
    var bytes;
    try {
      bytes = atob(body);
    } catch (e) {
      return null;
    }
    var HEX = "0123456789ABCDEF";
    var chunks = [];
    var chunk = "";
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes.charCodeAt(i);
      if (c < 0x21 || c === 0x23 || c === 0x25 || c >= 0x7f) {
        chunk += "%" + HEX.charAt(c >> 4) + HEX.charAt(c & 15);
      } else {
        chunk += bytes.charAt(i);
      }
      if (chunk.length >= 8192) {
        chunks[chunks.length] = chunk;
        chunk = "";
      }
    }
    chunks[chunks.length] = chunk;
    result += chunks.join("");
  }
  var n;
  try {
    n = new URL(result).href.length;
  } catch (e) {
    n = Infinity;
  }
  return n > ${MAX_DATA_URL} ? null : result;
}
`;
