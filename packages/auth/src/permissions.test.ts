import { describe, expect, it } from "vitest";
import { FORM_PERMISSIONS, formPermissions, orgPermissions, readsAllForms } from "./permissions.js";

describe("orgPermissions", () => {
  it("gives owners everything and admins everything except organization management", () => {
    expect(orgPermissions({ role: "owner", status: "active" }).has("organization.manage")).toBe(true);
    const admin = orgPermissions({ role: "admin", status: "active" });
    expect(admin.has("organization.manage")).toBe(false);
    expect(admin.has("integrations.manage")).toBe(true);
    expect(admin.has("members.manage")).toBe(true);
  });

  it("lets creators create forms but not manage the organization", () => {
    expect([...orgPermissions({ role: "creator", status: "active" })]).toEqual(["forms.create"]);
  });

  it("gives analysts and approvers no organization permissions", () => {
    expect(orgPermissions({ role: "analyst", status: "active" }).size).toBe(0);
    expect(orgPermissions({ role: "approver", status: "active" }).size).toBe(0);
  });

  it("gives revoked or missing memberships nothing, even owners", () => {
    expect(orgPermissions({ role: "owner", status: "revoked" }).size).toBe(0);
    expect(orgPermissions(undefined).size).toBe(0);
  });
});

describe("formPermissions", () => {
  it("gives owners every form permission without grants", () => {
    expect(formPermissions({ role: "owner", status: "active" }, []).size).toBe(FORM_PERMISSIONS.length);
  });

  it("requires explicit grants for admins to delete forms or responses", () => {
    const admin = formPermissions({ role: "admin", status: "active" }, []);
    expect(admin.has("forms.publish")).toBe(true);
    expect(admin.has("responses.export")).toBe(true);
    expect(admin.has("forms.delete")).toBe(false);
    expect(admin.has("responses.delete")).toBe(false);
    expect(formPermissions({ role: "admin", status: "active" }, ["forms.delete"]).has("forms.delete")).toBe(true);
  });

  it("does not give creators response access just because they can edit", () => {
    const creator = formPermissions({ role: "creator", status: "active" }, ["forms.edit"]);
    expect(creator.has("forms.edit")).toBe(true);
    expect(creator.has("responses.read")).toBe(false);
  });

  it("separates response reading from exporting for analysts", () => {
    const analyst = formPermissions({ role: "analyst", status: "active" }, ["responses.read"]);
    expect(analyst.has("responses.read")).toBe(true);
    expect(analyst.has("responses.export")).toBe(false);
  });

  it("implies forms.read from any grant, and nothing without one", () => {
    expect(formPermissions({ role: "analyst", status: "active" }, ["responses.read"]).has("forms.read")).toBe(true);
    expect(formPermissions({ role: "analyst", status: "active" }, []).size).toBe(0);
  });

  it("ignores grants for revoked members", () => {
    expect(formPermissions({ role: "creator", status: "revoked" }, ["forms.edit"]).size).toBe(0);
  });

  it("reports which roles read every form", () => {
    expect(readsAllForms({ role: "owner", status: "active" })).toBe(true);
    expect(readsAllForms({ role: "admin", status: "active" })).toBe(true);
    expect(readsAllForms({ role: "creator", status: "active" })).toBe(false);
    expect(readsAllForms({ role: "owner", status: "revoked" })).toBe(false);
  });
});
