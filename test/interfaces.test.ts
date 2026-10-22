import { describe, expect, test } from "bun:test";
import { listLocalIpv4Interfaces } from "../src/network/interfaces";

describe("listLocalIpv4Interfaces", () => {
  test("returns structured interface records", () => {
    const interfaces = listLocalIpv4Interfaces();

    for (const item of interfaces) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(item.cidr.length).toBeGreaterThan(0);
      expect(item.mac.length).toBeGreaterThan(0);
    }
  });
});
