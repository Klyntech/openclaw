export function sessionPerson(id: string, label: string, withAvatar = false) {
  return {
    type: "human" as const,
    id,
    identity: { type: "profile" as const, id },
    label,
    ...(withAvatar ? { avatarUrl: `/api/users/${id}/avatar?v=1` } : {}),
  };
}

export function sessionsList(
  owners: [string, string] = ["profile-ada", "profile-bob"],
  withAvatars = false,
  { categories = true, actorAvatars = false } = {},
) {
  const ada = sessionPerson(owners[0], "Ada", actorAvatars);
  const bob = sessionPerson(owners[1], owners[1] === owners[0] ? "Ada" : "Bob", actorAvatars);
  const ownerFacet = owners[1] === owners[0] ? [ada] : [ada, bob];
  return {
    count: 2,
    owners: ownerFacet.map((actor) => sessionPerson(actor.id, actor.label, withAvatars)),
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [ada, bob].map((actor, index) =>
      Object.assign(
        {
          key: `agent:main:${index === 0 ? "ada" : "bob"}`,
          kind: "direct",
          label: index === 0 ? "Ada research" : "Bob operations",
          createdActor: actor,
          owner: { actor },
          updatedAt: 2 - index,
        },
        categories ? { category: index === 0 ? "Research" : "Operations" } : {},
      ),
    ),
    ts: 1,
  };
}

export function draftSessionsList() {
  const result = sessionsList();
  for (const session of result.sessions) {
    Object.assign(session, { visibility: "draft", sharingRole: "admin" });
  }
  return result;
}

export function collaborativeSessionsList() {
  const ada = sessionPerson("profile-ada", "Ada", true);
  const bob = sessionPerson("profile-bob", "Bob", true);
  const carol = { type: "human" as const, id: "profile-carol", label: "Carol" };
  const participant = ({ identity, label, avatarUrl }: typeof ada) => ({
    identity,
    label,
    avatarUrl,
  });
  const participants = [
    [participant(bob)],
    [participant(ada), { identity: { type: "agent" as const, id: "research" }, label: "Research" }],
  ];
  return {
    count: 3,
    owners: [ada, bob, carol],
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [ada, bob, carol].map((actor, index) =>
      Object.assign(
        {
          key: `agent:main:${["collaboration", "release-planning", "single-owner"][index]}`,
          kind: "direct",
          label: ["Fix issue #127689", "Release planning", "Single-owner baseline"][index],
          createdActor: actor,
          owner: { actor },
          updatedAt: 3 - index,
        },
        index < 2 ? { participants: participants[index], participantCount: index + 1 } : {},
      ),
    ),
    ts: 1,
  };
}
