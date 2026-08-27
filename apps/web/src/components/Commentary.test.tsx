import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Commentary } from "./Commentary";

/**
 * Builds a `fetch` stub that resolves with the given JSON body/status,
 * so each test controls exactly what `/api/bot` "returns" without any
 * network.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The parsed body of the Nth `fetch` call this component made. */
function requestBody(call = 0): unknown {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

describe("Commentary", () => {
  // The auction is the product; commentary is decoration bolted onto its
  // *end*. Requesting it mid-auction would both spend provider tokens on
  // an outcome that does not exist yet and, worse, produce a comment about
  // a "winner" who is merely the current leader.
  it("requests nothing and renders nothing while the auction is still open", () => {
    render(<Commentary settled={false} itemName="A Rare Thing" winner="ada" price={500} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();
  });

  it("renders the commentary text once the auction has settled", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ text: "Sold to ada for 500. A tidy result.", provider: "gemini" })
    );

    render(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

    expect(await screen.findByTestId("commentary")).toHaveTextContent(
      "Sold to ada for 500. A tidy result."
    );
    // Exactly one request, not one per render. `setText` above re-renders
    // this component, so an effect with a missing (or object-identity)
    // dependency list would fire again here and loop -- this count is what
    // catches that.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts to /api/bot with the settled outcome shape the route accepts", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "Sold.", provider: "gemini" }));

    render(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);
    await screen.findByTestId("commentary");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/bot");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect(requestBody()).toEqual({ itemName: "A Rare Thing", winner: "ada", price: 500 });
  });

  // `/api/bot`'s schema is a discriminated union: winner and price are
  // either both present or both null (see that route, and
  // `@openbid/llm`'s `AuctionOutcome`). Anything else is a 400. This
  // component must therefore never post a half-populated outcome, even
  // when its own inputs are half-populated.
  describe("never posts a body the route would reject as a caller error", () => {
    it("posts the no-bids shape when the auction closed with no winner", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ text: "Nobody wanted it.", provider: "gemini" }));

      render(<Commentary settled itemName="A Rare Thing" winner={null} price={null} />);
      await screen.findByTestId("commentary");

      expect(requestBody()).toEqual({ itemName: "A Rare Thing", winner: null, price: null });
    });

    // Reachable in `LiveRoom`: the winner's nickname is resolved by
    // looking `winner.participantId` up in `state.participants`, which
    // can miss, in which case LiveRoom itself renders "unknown". Passing
    // that through as `winner: null, price: 500` would be a 400 and no
    // commentary at all; collapsing to the no-bids shape at least gets a
    // comment about the lot.
    it("collapses a winner with no price to the no-bids shape", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ text: "A quiet close.", provider: "gemini" }));

      render(<Commentary settled itemName="A Rare Thing" winner="ada" price={null} />);
      await screen.findByTestId("commentary");

      expect(requestBody()).toEqual({ itemName: "A Rare Thing", winner: null, price: null });
    });

    it("collapses a price with no winner to the no-bids shape", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ text: "A quiet close.", provider: "gemini" }));

      render(<Commentary settled itemName="A Rare Thing" winner={null} price={500} />);
      await screen.findByTestId("commentary");

      expect(requestBody()).toEqual({ itemName: "A Rare Thing", winner: null, price: null });
    });
  });

  // The whole point of this component's contract: the auction must never
  // break because commentary didn't arrive. Each of these is a real,
  // reachable failure -- an unconfigured provider (the default state of
  // this app with no GEMINI_API_KEY), a dead network, and this route's own
  // rate limiter -- and each must leave the room page rendering exactly
  // what it rendered before, with nothing thrown.
  describe("degrades silently", () => {
    it("renders nothing when the route degrades to empty text (no provider configured)", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ text: "", provider: null, error: "commentary unavailable" })
      );

      render(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();
    });

    it("renders nothing when the text is whitespace only", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ text: "   \n ", provider: "gemini" }));

      render(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();
    });

    it("renders nothing, and does not throw, when the request rejects outright", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

      render(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();
    });

    it("renders nothing when the route returns a non-2xx (e.g. 429 rate limited)", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "rate limited" }, 429));

      render(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();
    });

    it("renders nothing when the response body is not the shape this component expects", async () => {
      // A 200 whose `text` is not a string at all -- the failure mode a
      // bare `json.text` read would render as the literal "undefined"
      // or, worse, as `[object Object]`.
      fetchMock.mockResolvedValue(jsonResponse({ text: { unexpected: true } }));

      render(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();
    });

    it("renders nothing when the response is a 200 with a non-JSON body", async () => {
      fetchMock.mockResolvedValue(new Response("<html>gateway error</html>", { status: 200 }));

      render(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();
    });
  });

  it("does not re-request when re-rendered with the same outcome", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "Sold.", provider: "gemini" }));

    const { rerender } = render(
      <Commentary settled itemName="A Rare Thing" winner="ada" price={500} />
    );
    await screen.findByTestId("commentary");

    rerender(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);
    rerender(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The real transition this component exists for: it mounts on an open
  // auction (LiveRoom renders it before the close event arrives) and must
  // fire exactly once, when `settled` flips -- not on mount, and not again
  // afterwards.
  it("requests exactly once, at the moment the auction transitions to settled", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "Sold.", provider: "gemini" }));

    const { rerender } = render(
      <Commentary settled={false} itemName="A Rare Thing" winner={null} price={null} />
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(<Commentary settled itemName="A Rare Thing" winner="ada" price={500} />);

    await screen.findByTestId("commentary");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody()).toEqual({ itemName: "A Rare Thing", winner: "ada", price: 500 });
  });
});
