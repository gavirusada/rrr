import { describe, expect, test } from "bun:test";
import { parseCanonUpnpDescriptor } from "../src/canon/upnpDescriptor";

describe("parseCanonUpnpDescriptor", () => {
  test("extracts Canon camera service details", () => {
    const xml = `<?xml version="1.0"?>
      <root xmlns="urn:schemas-upnp-org:device-1-0">
        <device>
          <friendlyName>Canon EOS Rebel T100</friendlyName>
          <modelName>Canon EOS Rebel T100</modelName>
          <serialNumber>482072014821</serialNumber>
          <UDN>uuid:00000000-0000-0000-0001-5C625AB30342</UDN>
          <serviceList>
            <service>
              <serviceType>urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1</serviceType>
              <SCPDURL>CameraSvcDesc.xml</SCPDURL>
              <controlURL>control/CanonCamera/</controlURL>
            </service>
          </serviceList>
        </device>
      </root>`;

    expect(parseCanonUpnpDescriptor(xml)).toEqual({
      friendlyName: "Canon EOS Rebel T100",
      modelName: "Canon EOS Rebel T100",
      serialNumber: "482072014821",
      udn: "uuid:00000000-0000-0000-0001-5C625AB30342",
      serviceType: "urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1",
      scpdUrl: "CameraSvcDesc.xml",
      controlUrl: "control/CanonCamera/"
    });
  });
});
