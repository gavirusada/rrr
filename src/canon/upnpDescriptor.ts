import http from "node:http";
import { spawn } from "node:child_process";

export interface CanonUpnpDescriptor {
  friendlyName: string;
  modelName: string;
  serialNumber: string;
  udn: string;
  serviceType: string;
  scpdUrl: string;
  controlUrl: string;
}

export interface FetchDescriptorOptions {
  location: string;
  localAddress?: string;
  timeoutMs?: number;
}

export function parseCanonUpnpDescriptor(xml: string): CanonUpnpDescriptor {
  return {
    friendlyName: readTag(xml, "friendlyName"),
    modelName: readTag(xml, "modelName"),
    serialNumber: readTag(xml, "serialNumber"),
    udn: readTag(xml, "UDN"),
    serviceType: readTag(xml, "serviceType"),
    scpdUrl: readTag(xml, "SCPDURL"),
    controlUrl: readTag(xml, "controlURL")
  };
}

export async function fetchCanonUpnpDescriptor(options: FetchDescriptorOptions): Promise<CanonUpnpDescriptor> {
  const xml = await fetchTextWithFallback(options);
  return parseCanonUpnpDescriptor(xml);
}

async function fetchTextWithFallback(options: FetchDescriptorOptions): Promise<string> {
  try {
    return await fetchText(options);
  } catch (error) {
    if (process.platform !== "win32" || options.localAddress === undefined) {
      throw error;
    }

    return await fetchTextWithCurl(options);
  }
}

async function fetchText(options: FetchDescriptorOptions): Promise<string> {
  const url = new URL(options.location);
  const timeoutMs = options.timeoutMs ?? 5000;

  return await new Promise<string>((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
        timeout: timeoutMs
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode ?? "unknown"} fetching ${options.location}`));
            return;
          }

          resolve(body);
        });
      }
    );

    request.once("timeout", () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.once("error", reject);
    request.end();
  });
}

function readTag(xml: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i");
  const match = pattern.exec(xml);
  if (match?.[1] === undefined) {
    throw new Error(`Missing <${tagName}> in Canon UPnP descriptor`);
  }

  return decodeXmlEntities(match[1].trim());
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

async function fetchTextWithCurl(options: FetchDescriptorOptions): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("curl.exe", [
      "--interface",
      options.localAddress ?? "",
      "--max-time",
      String(Math.ceil((options.timeoutMs ?? 5000) / 1000)),
      "--silent",
      "--show-error",
      options.location
    ]);

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl.exe exited with code ${code ?? "unknown"}`));
        return;
      }

      resolve(stdout);
    });
  });
}
