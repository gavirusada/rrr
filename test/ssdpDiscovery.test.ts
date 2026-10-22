import { describe, expect, test } from "bun:test";
import { parseSsdpCameraResponse } from "../src/canon/ssdpDiscovery";

describe("parseSsdpCameraResponse", () => {
  test("parses Canon smartphone service response", () => {
    const response = [
      "HTTP/1.1 200 OK",
      "Cache-Control: max-age=1800",
      "EXT:",
      "Location: http://192.168.1.2:49152/upnp/CameraDevDesc.xml",
      "Server: Camera OS/1.0 UPnP/1.0 Canon Device Discovery/1.0",
      "ST: urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      "USN: uuid:00000000-0000-0000-0001-5C625AB30342::urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      "",
      ""
    ].join("\r\n");

    expect(parseSsdpCameraResponse(response, "192.168.1.2", 54911)).toEqual({
      address: "192.168.1.2",
      port: 54911,
      location: "http://192.168.1.2:49152/upnp/CameraDevDesc.xml",
      server: "Camera OS/1.0 UPnP/1.0 Canon Device Discovery/1.0",
      serviceType: "urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      usn: "uuid:00000000-0000-0000-0001-5C625AB30342::urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1"
    });
  });

  test("ignores non-Canon SSDP responses", () => {
    const response = [
      "HTTP/1.1 200 OK",
      "ST: upnp:rootdevice",
      "Location: http://192.168.1.1/root.xml",
      "USN: uuid:router::upnp:rootdevice",
      "",
      ""
    ].join("\r\n");

    expect(parseSsdpCameraResponse(response, "192.168.1.1", 1900)).toBeNull();
  });

  test("parses Canon multicast alive notifications", () => {
    const response = [
      "NOTIFY * HTTP/1.1",
      "Host: 239.255.255.250:1900",
      "Cache-Control: max-age=1800",
      "Location: http://192.168.1.2:49152/upnp/CameraDevDesc.xml",
      "NT: urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      "NTS: ssdp:alive",
      "Server: Camera OS/1.0 UPnP/1.0 Canon Device Discovery/1.0",
      "USN: uuid:camera::urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      "",
      ""
    ].join("\r\n");

    expect(parseSsdpCameraResponse(response, "192.168.1.2", 1900)).toEqual({
      address: "192.168.1.2",
      port: 1900,
      location: "http://192.168.1.2:49152/upnp/CameraDevDesc.xml",
      server: "Camera OS/1.0 UPnP/1.0 Canon Device Discovery/1.0",
      serviceType: "urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      usn: "uuid:camera::urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1"
    });
  });

  test("ignores Canon byebye notifications", () => {
    const response = [
      "NOTIFY * HTTP/1.1",
      "NT: urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      "NTS: ssdp:byebye",
      "USN: uuid:camera::urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      "",
      ""
    ].join("\r\n");

    expect(parseSsdpCameraResponse(response, "192.168.1.2", 1900)).toBeNull();
  });
});
