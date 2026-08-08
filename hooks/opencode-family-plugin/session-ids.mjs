// Session-id helpers for the opencode-family plugin core.
//
// Prefix classification (get this wrong and family child sessions break
// silently — see plan-opencode-family-shared-integration.md §3.2):
//
//   prefix-INDEPENDENT — plain module exports below:
//     getEventSessionId, getEventParentSessionId,
//     shouldDropMappedEventWithoutSessionId
//
//   prefix-DEPENDENT — produced by createSessionIdHelpers(prefix):
//     DEFAULT_SESSION_ID, normalizeSessionId, resolveSessionId,
//     isChildSessionId, cleanupSessionParentMap
//
// The last two LOOK neutral but must normalize through the SAME prefix that
// wrote the parent-map keys: a mimocode child key "mimocode:ses_child" looked
// up via an opencode normalizer would miss forever — child never marked
// headless, child session.idle misroutes to Stop, and session.deleted deletes
// under the wrong prefix so the map leaks for the life of the process.

function normalizeSessionText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getEventSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  return normalizeSessionText(props.sessionID) || normalizeSessionText(event.sessionID);
}

// Extract the parent session ID from a session.created event.
// opencode SDK ≥1.15.13: event.properties.info.parentID (Session.parentID).
// Returns null if absent (root session or older SDK).
export function getEventParentSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  const info = props.info && typeof props.info === "object" ? props.info : {};
  const parentID = info.parentID;
  return typeof parentID === "string" && parentID.trim() ? parentID.trim() : null;
}

export function shouldDropMappedEventWithoutSessionId(event, mapped) {
  return mapped
    && mapped.event === "SessionEnd"
    && !getEventSessionId(event);
}

/**
 * Build the prefix-dependent helper set for one family member.
 *
 * @param {string} prefix  e.g. "opencode:" — must match the agent's registry
 *   entry (agents/opencode-family.js sessionIdPrefix)
 */
export function createSessionIdHelpers(prefix) {
  if (typeof prefix !== "string" || !prefix) {
    throw new Error("createSessionIdHelpers: prefix is required");
  }

  const DEFAULT_SESSION_ID = `${prefix}default`;

  function normalizeSessionId(value) {
    const raw = normalizeSessionText(value);
    if (!raw) return null;
    return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
  }

  function resolveSessionId(current, fallback) {
    return normalizeSessionId(current)
      || normalizeSessionId(fallback)
      || DEFAULT_SESSION_ID;
  }

  // Check whether a session ID is a child session by looking up the
  // session→parentId map. The map is maintained by the plugin's event handler
  // (populated on session.created, cleaned on session.deleted/disposed).
  // Both the map keys and the lookup sessionId are normalized via
  // normalizeSessionId() so raw ("ses_child") and prefixed
  // ("<prefix>ses_child") forms match consistently.
  function isChildSessionId(sessionId, sessionParentById) {
    if (!sessionId || !sessionParentById || typeof sessionParentById.has !== "function") {
      return false;
    }
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return false;
    return sessionParentById.has(normalized);
  }

  // Clean up _sessionParentById on session end events so the Map doesn't grow
  // unboundedly across sessions. Must be called BEFORE shouldDropMappedEventWithoutSessionId()
  // because server.instance.disposed may lack a sessionID (causing early return) but
  // still needs to clear the entire map — all sessions are gone.
  //   - session.deleted: removes the single entry for that session (if present).
  //   - server.instance.disposed: clears the entire map.
  function cleanupSessionParentMap(event, map) {
    if (!event || typeof event.type !== "string") return;
    if (!map || typeof map.clear !== "function") return;

    if (event.type === "server.instance.disposed") {
      map.clear();
      return;
    }

    if (event.type === "session.deleted") {
      const rawSid = getEventSessionId(event);
      const normSid = normalizeSessionId(rawSid);
      if (normSid && map.has(normSid)) {
        map.delete(normSid);
      }
    }
  }

  return {
    DEFAULT_SESSION_ID,
    normalizeSessionId,
    resolveSessionId,
    isChildSessionId,
    cleanupSessionParentMap,
  };
}
