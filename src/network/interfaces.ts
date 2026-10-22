import os from "node:os";

export interface LocalIpv4Interface {
  name: string;
  address: string;
  cidr: string;
  mac: string;
}

export function listLocalIpv4Interfaces(): LocalIpv4Interface[] {
  const interfaces = os.networkInterfaces();
  const result: LocalIpv4Interface[] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }

      result.push({
        name,
        address: entry.address,
        cidr: entry.cidr ?? `${entry.address}/${entry.netmask}`,
        mac: entry.mac
      });
    }
  }

  return result;
}
