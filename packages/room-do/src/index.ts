export { RoomDO } from "./RoomDO.js";

interface Env {
  ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/rooms\/([A-Za-z0-9_-]+)\/(init|snapshot|ws)$/.exec(url.pathname);
    if (match === null) return new Response("not found", { status: 404 });

    const id = env.ROOMS.idFromName(match[1]!);
    return env.ROOMS.get(id).fetch(request);
  },
};
