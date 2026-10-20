import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { readUserProfileAliasRevision } from "./user-profile-events.js";
import { readUserProfileSnapshotSync } from "./user-profile-list-item.test-support.js";
import { readUserProfileAliases } from "./user-profile-list.js";
import { syncGitHubIdentity } from "./user-profile-writes.worker.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";
import { repairMergedGatewayOwnerProfile } from "./user-profiles-owner-migration.js";
import { mergeOwnerIntoPerson, profileState } from "./user-profiles-owner.test-support.js";
import { ensureGatewayOwnerProfile, ensureProfileForTailscaleIdentity } from "./user-profiles.js";

const { options, hydrate } = useProfileDatabase("openclaw-owner-migration-");

const repair = (shouldRepair: boolean) =>
  repairMergedGatewayOwnerProfile({ ...options, shouldRepair });
const readProfile = (id: string) =>
  readUserProfileSnapshotSync(options).profiles.find((row) => row.id === id);
const unchanged = { repaired: false, changes: [], warnings: [] };

describe("Doctor gateway owner repair", () => {
  it.each(["tombstone", "person", "missing"])(
    "reports then repairs a merged owner with its identity targeting %s once",
    async (identityTarget) => {
      const owner = ensureGatewayOwnerProfile("Local Owner", options);
      const person = mergeOwnerIntoPerson(owner.id, options);
      syncGitHubIdentity(
        {
          identity: { accountId: 10, login: "person" },
          authenticationAlias: { kind: "email", email: "person@example.test" },
        },
        options,
      );
      const db = openOpenClawStateDatabase(options).db;
      if (identityTarget === "person") {
        db.prepare(
          "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local'",
        ).run(person.id);
      } else if (identityTarget === "missing") {
        db.prepare("DELETE FROM user_profile_identities WHERE provider = 'gateway.local'").run();
      }
      const personBefore = readProfile(person.id);
      const before = profileState(options);
      const aliasRevision = readUserProfileAliasRevision();
      await hydrate();
      expect(readUserProfileAliases(owner.id, options)).toEqual(new Set([owner.id, person.id]));
      expect(readUserProfileAliases(person.id, options)).toEqual(new Set([owner.id, person.id]));

      expect(repair(false)).toMatchObject({
        repaired: false,
        changes: [],
        warnings: [expect.stringContaining("openclaw doctor --fix")],
      });
      expect(profileState(options)).toEqual(before);
      expect(readUserProfileAliasRevision()).toBe(aliasRevision);
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          expect(repair(true).repaired).toBe(true);
          expect(readUserProfileAliasRevision()).toBe(aliasRevision);
          throw new Error("rollback owner repair");
        }, options),
      ).toThrow("rollback owner repair");
      expect(readUserProfileAliasRevision()).toBe(aliasRevision);
      expect(profileState(options)).toEqual(before);
      expect(repair(true)).toMatchObject({
        repaired: true,
        changes: [expect.stringContaining("gateway-owner")],
        warnings: [],
      });
      expect(readUserProfileAliases(owner.id, options)).toEqual(new Set([owner.id]));
      expect(readUserProfileAliasRevision()).toBe(aliasRevision + 1);
      expect(readUserProfileAliases(person.id, options)).toEqual(new Set([person.id]));
      const restored = ensureGatewayOwnerProfile("Host Renamed", options);
      expect(restored).toMatchObject({
        id: owner.id,
        mergedInto: null,
        displayName: "Local Owner",
      });
      expect(restored.updatedAt).toBeGreaterThan(1);
      expect(readProfile(person.id)).toEqual(personBefore);
      expect(
        db
          .prepare(
            "SELECT profile_id FROM user_profile_identities WHERE provider = 'gateway.local' AND subject = 'owner'",
          )
          .get(),
      ).toEqual({ profile_id: owner.id });
      const repairedState = profileState(options);
      expect(repair(true)).toEqual(unchanged);
      expect(readUserProfileAliasRevision()).toBe(aliasRevision + 1);
      closeOpenClawStateDatabaseForTest();
      expect(profileState(options)).toEqual(repairedState);
    },
  );

  it.each([false, true])(
    "preserves an unmerged legacy owner and replaces a merged one (merged: %s)",
    (merged) => {
      const legacy = ensureProfileForTailscaleIdentity({ login: "legacy@other" }, options);
      if (merged) {
        mergeOwnerIntoPerson(legacy.id, options);
      }
      const db = openOpenClawStateDatabase(options).db;
      db.prepare(
        "INSERT INTO user_profile_identities (provider, subject, profile_id, created_at) VALUES ('gateway.local', 'owner', ?, 1)",
      ).run(legacy.id);
      const before = profileState(options);
      const aliasRevision = readUserProfileAliasRevision();
      expect(repair(true).repaired).toBe(merged);
      if (!merged) {
        expect(profileState(options)).toEqual(before);
      } else {
        expect(
          db.prepare("SELECT merged_into FROM user_profiles WHERE id = ?").get(legacy.id),
        ).toEqual({
          merged_into: before.profiles.find((profile) => profile.id === legacy.id)?.merged_into,
        });
      }
      expect(ensureGatewayOwnerProfile("Local Owner", options).id).toBe(
        merged ? "gateway-owner" : legacy.id,
      );
      expect(readUserProfileAliasRevision()).toBe(aliasRevision);
    },
  );

  it.each([false, true])(
    "does not create profile state on an unused Gateway (fix: %s)",
    (shouldRepair) => {
      const aliasRevision = readUserProfileAliasRevision();
      expect(repair(shouldRepair)).toEqual(unchanged);
      expect(existsSync(options.path)).toBe(false);
      expect(readUserProfileAliasRevision()).toBe(aliasRevision);
    },
  );
});
