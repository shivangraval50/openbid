export { RoomDO } from "./RoomDO.js";
export { LobbyDO } from "./LobbyDO.js";

interface Env {
  ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The lobby is a deliberate singleton — every request for it, regardless
    // of path, is addressed to the same object.
    if (url.pathname.startsWith("/lobby/")) {
      return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch(request);
    }

    const match = /^\/rooms\/([A-Za-z0-9_-]+)\/(init|snapshot|ws)$/.exec(url.pathname);
    if (match === null) return new Response("not found", { status: 404 });

    const id = env.ROOMS.idFromName(match[1]!);
    return env.ROOMS.get(id).fetch(request);
  },
};
