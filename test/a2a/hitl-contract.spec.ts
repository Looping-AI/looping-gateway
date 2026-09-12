import { describe, it, expect, expectTypeOf } from "vitest";
import { Role, type Message, type Part } from "@a2a-js/sdk";
import {
  HITL_REQUEST_KINDS,
  HITL_REQUEST_TYPE,
  HITL_RESPONSE_TYPE,
  type HitlOption,
  type HitlRequestData,
  type HitlResponseData
} from "@dynamicagents/g2a-protocol";
import { buildMessage } from "@/a2a/parts";
import {
  buildHitlRequestParts,
  buildHitlResponseParts,
  parseHitlRequest,
  parseHitlResponse,
  toSlackInputRequest,
  type HitlRequest,
  type HitlResponse
} from "@/a2a/hitl";

/**
 * The HITL half of the wire contract, as a conformance test — the counterpart to
 * `test/auth/wire-contract.spec.ts`, and for the same reason.
 *
 * `@dynamicagents/g2a-protocol` declares these shapes as **types only**: it holds
 * no runtime and no validator, because a validator there would be behaviour and
 * a dependency. So each side validates with the schema library it already
 * carries, and the gatekeeper's zod schemas are a hand-written restatement of a
 * contract nothing compares them against. This file is that comparison.
 *
 * It is the only place that imports the protocol's HITL *shapes* — the types the
 * schemas below are checked against — anywhere but `src/a2a/hitl.ts`, which
 * re-exports them for everyone else. Two modules do import a protocol HITL name
 * directly, and both are enforcement rather than reading: `src/db/schema.ts` and
 * `src/db/models/hitl-requests.ts` take `HITL_REQUEST_KINDS` and
 * `HitlRequestKind` to type the `request_kind` column, since going through
 * `@/a2a` would point the db layer at the A2A layer.
 *
 * **What this catches and what it does not.** A field renamed, removed, or
 * retyped upstream fails these — assignability breaks in one direction or the
 * other. A field *added* upstream does not: an optional property is assignable
 * both ways, so a request carrying a new field parses fine and the gatekeeper
 * ignores it, which is the behaviour you want from a reader anyway. Nothing here
 * substitutes for reading a protocol bump's diff.
 */

/** A message carrying `parts`, as the far side would have sent it. */
function sent(parts: Part[], role: Role = Role.ROLE_AGENT): Message {
  return buildMessage({ messageId: "m1", role, parts });
}

describe("the validator, against the contract it restates", () => {
  it("accepts everything a conformant peer can send", () => {
    // Checked by `tsc -p test/tsconfig.json` and invisible to vitest, which
    // transpiles specs without typechecking them — so this passes a green
    // `npm test` no matter what it says. `npm run check` is the gate.
    //
    // The direction is the one that matters for a reader: anything the contract
    // permits must survive this module's parse. Were `HitlRequest` still
    // `z.infer` of the local schema, a field dropped from that schema would go
    // unnoticed here and surface as a question rendered without its options.
    expectTypeOf<HitlRequestData>().toExtend<HitlRequest>();
    expectTypeOf<HitlResponseData>().toExtend<HitlResponse>();
  });

  it("emits an answer shaped the way the contract requires", () => {
    // The writing direction. It does not hold as an assignability check —
    // `HitlResponse` is deliberately *wider* than the contract, accepting an
    // optionId, or text, or both — so what pins this side is the
    // `HitlResponseData` annotation inside `buildHitlResponseParts`, and what
    // this asserts is that the part it produces round-trips whole.
    const answered = parseHitlResponse(
      sent(
        buildHitlResponseParts({
          requestId: "r-1",
          optionId: "approve",
          answeredBy: "U123",
          humanText: "Approve"
        }),
        Role.ROLE_USER
      )
    );

    expect(answered).toEqual({
      type: HITL_RESPONSE_TYPE,
      requestId: "r-1",
      optionId: "approve",
      answeredBy: "U123"
    });
  });

  it("covers every kind the contract defines", () => {
    // Driven by the protocol's tuple rather than a list spelled here, so a kind
    // added upstream is exercised on the next install with no edit to this file
    // — and fails loudly if the local `z.enum` was not derived from that tuple.
    for (const requestKind of HITL_REQUEST_KINDS) {
      const request: HitlRequestData = {
        type: HITL_REQUEST_TYPE,
        requestId: `r-${requestKind}`,
        requestKind,
        prompt: `Decide: ${requestKind}`,
        options: [
          { id: "a", label: "A", description: "first", style: "primary" },
          { id: "b", label: "B", style: "danger" }
        ],
        display: "radio",
        allowFreeform: true
      };

      // Every field, not a spot-check: a round-trip that silently drops one is
      // the failure this file exists to catch.
      expect(parseHitlRequest(sent(buildHitlRequestParts(request)))).toEqual(
        request
      );
    }
  });

  it("exhausts the unions the contract carries no tuple for", () => {
    // `display` and `HitlOption["style"]` are spelled out in this module's zod
    // enums, because the protocol offers no tuple to build them from. Those two
    // are therefore where drift can hide: widen either union upstream and the
    // local enum rejects the new member at runtime with no build error anywhere.
    //
    // Declaring a total record over each union turns that into a compile error
    // — a member added upstream leaves a key missing here.
    const displays: Record<NonNullable<HitlRequestData["display"]>, true> = {
      buttons: true,
      radio: true,
      select: true
    };
    const styles: Record<NonNullable<HitlOption["style"]>, true> = {
      primary: true,
      danger: true,
      default: true
    };

    for (const display of Object.keys(displays) as (keyof typeof displays)[]) {
      const parsed = parseHitlRequest(
        sent(
          buildHitlRequestParts({
            type: HITL_REQUEST_TYPE,
            requestId: "r-d",
            requestKind: "choice",
            prompt: "Pick",
            options: [{ id: "a", label: "A" }],
            display
          })
        )
      );
      expect(parsed?.display).toBe(display);
    }

    for (const style of Object.keys(styles) as (keyof typeof styles)[]) {
      const parsed = parseHitlRequest(
        sent(
          buildHitlRequestParts({
            type: HITL_REQUEST_TYPE,
            requestId: "r-s",
            requestKind: "choice",
            prompt: "Pick",
            options: [{ id: "a", label: "A", style }]
          })
        )
      );
      expect(parsed?.options?.[0]?.style).toBe(style);
    }
  });
});

/**
 * Both fixtures below are the two branches of core's `questionFor`
 * ([`src/round/agent.ts`](https://github.com/dynamicagents/core/pull/35), on
 * `r4/ask-user`), not shapes invented here: always `requestKind: "choice"`,
 * never a `display`, and either `option_1…N` ids *or* `allowFreeform: true` —
 * core sets the two in an either/or, so neither fixture carries both.
 *
 * Core's `askUserInputSchema` bounds the list at `.min(2).max(MAX_ASK_OPTIONS)`
 * with `MAX_ASK_OPTIONS = 6`, so the six-option case is its ceiling. Note this
 * is *core's* limit and not the gatekeeper's own `ask_user`
 * ([`src/agents/shared/ask-user.ts`](../../src/agents/shared/ask-user.ts)),
 * which allows 1–5 — two different producers, and this file is about the remote.
 */
describe("what core actually sends", () => {
  it("renders a six-option choice in order, with no display named", () => {
    // Core's ceiling: the most options it can put in front of a person at once.
    const request: HitlRequestData = {
      type: HITL_REQUEST_TYPE,
      requestId: "core-1",
      requestKind: "choice",
      prompt: "Which environment?",
      options: Array.from({ length: 6 }, (_, i) => ({
        id: `option_${i + 1}`,
        label: `Option ${i + 1}`
      }))
    };

    const parsed = parseHitlRequest(sent(buildHitlRequestParts(request)));
    expect(parsed).toEqual(request);

    const slack = toSlackInputRequest(parsed as HitlRequest);
    // Order is load-bearing: the agent reads the answer back by id, but a person
    // picks by position, and a reordering makes those two disagree silently.
    expect(slack.options?.map((o) => o.id)).toEqual([
      "option_1",
      "option_2",
      "option_3",
      "option_4",
      "option_5",
      "option_6"
    ]);
    expect(slack.display).toBe("buttons");
  });

  it("renders a freeform-only question with no options at all", () => {
    const parsed = parseHitlRequest(
      sent(
        buildHitlRequestParts({
          type: HITL_REQUEST_TYPE,
          requestId: "core-2",
          requestKind: "choice",
          prompt: "What should I name it?",
          allowFreeform: true
        })
      )
    );

    const slack = toSlackInputRequest(parsed as HitlRequest);
    // No Approve/Reject fill: that is for `approval`, and inventing two buttons
    // for an open question would answer it on the person's behalf.
    expect(slack.options).toBeUndefined();
    expect(slack.allowFreeform).toBe(true);
  });
});
