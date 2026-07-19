import { describe, expect, it } from "vitest";
import {
  agentNamespace,
  durableParentThreadNamespace,
  ownsAgentNamespace,
} from "./namespace";

describe("agent namespace helpers", () => {
  it("builds durable parent owner namespaces with thread terminology", () => {
    expect(
      durableParentThreadNamespace({
        agentOwnerNamespace: agentNamespace("coordinator"),
        generation: 2,
        threadKey: "room/1",
      })
    ).toBe("agent:coordinator:thread:room%2F1:generation:2");
  });

  it("accepts current thread owner namespaces only", () => {
    const ownerNamespace = agentNamespace("coordinator");

    expect(ownsAgentNamespace(ownerNamespace, ownerNamespace)).toBe(true);
    expect(
      ownsAgentNamespace(
        `${ownerNamespace}:thread:room%2F1:generation:2`,
        ownerNamespace
      )
    ).toBe(true);
    expect(
      ownsAgentNamespace(
        `${ownerNamespace}:session:room%2F1:generation:2`,
        ownerNamespace
      )
    ).toBe(false);
    expect(
      ownsAgentNamespace(
        `${agentNamespace("other")}:thread:room%2F1:generation:2`,
        ownerNamespace
      )
    ).toBe(false);
  });
});
